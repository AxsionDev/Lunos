export * as Residency from "./residency"

import { Jurisdiction } from "./jurisdiction"
import { Audit } from "./audit"

/**
 * Data-residency policy evaluation (XCOD-62).
 *
 * Deliberately pure and free of Effect scaffolding: the decision is a function of a provider id
 * and a policy, nothing else. The plugin in `plugin/residency.ts` is the only wiring, so this
 * logic stays directly testable.
 *
 * There are two enforcement points, and both call `enforce()` below: the v2 `AISDK.language()`
 * by way of the `aisdk.sdk` hook (`plugin/residency.ts`), and the v1 provider's SDK resolution
 * (`packages/opencode/src/provider/provider.ts`), which is the path live sessions take. Either
 * one throwing becomes an `InitError`, so a denied provider never yields a language model.
 */

export interface Policy {
  /** Regions a deployment is permitted to send data to, e.g. `["eu"]`. */
  readonly allow: readonly Jurisdiction.Region[]
}

export interface Decision {
  readonly allowed: boolean
  readonly providerID: string
  readonly region: Jurisdiction.Region
  /** Human-readable justification. Surfaced in the error, so it must explain what to do next. */
  readonly reason: string
}

/**
 * Evaluate a provider against a residency policy.
 *
 * Fails closed, in two distinct ways that are easy to conflate:
 *
 * 1. A provider with **no recorded jurisdiction** is denied. It is not "probably fine" — an
 *    untagged provider is one nobody has checked, which is precisely when a residency guarantee
 *    would be silently untrue.
 * 2. A **`configurable`** provider (Azure, Bedrock, Vertex, SAP AI Core) is denied under an
 *    EU-only policy even though it *can* be EU. Nothing observable from here proves this
 *    particular deployment pointed it at an EU region, and a policy that lets an unverified
 *    US-region Azure resource through is worse than no policy, because it reports success.
 *    The deployer can still use it by widening `allow` — an explicit, auditable choice.
 */
export function evaluate(providerID: string, policy: Policy): Decision {
  const claim = Jurisdiction.lookup(providerID)
  const base = { providerID, region: claim.region }
  const allowed = policy.allow.join(", ")

  if (!Jurisdiction.isTagged(providerID)) {
    return {
      ...base,
      allowed: false,
      reason: `Provider "${providerID}" has no recorded data-processing jurisdiction, and the active residency policy allows only: ${allowed}. Untagged providers are denied rather than assumed compliant. Add an entry in packages/core/src/jurisdiction.ts if this provider should be usable.`,
    }
  }

  if (policy.allow.includes(claim.region)) {
    return {
      ...base,
      allowed: true,
      reason: `Provider "${providerID}" processes in "${claim.region}", which the residency policy allows.`,
    }
  }

  if (claim.region === "configurable") {
    const how = claim.euOption ? ` ${claim.euOption}` : ""
    return {
      ...base,
      allowed: false,
      reason: `Provider "${providerID}" processes wherever it is configured to, and the residency policy (${allowed}) cannot verify which region this deployment uses, so it is denied.${how} Once confirmed, add "configurable" to the residency allow list to permit it.`,
    }
  }

  if (claim.basis === "gateway") {
    return {
      ...base,
      allowed: false,
      reason: `Provider "${providerID}" is a gateway that routes onward to other providers, so no single jurisdiction can be guaranteed. The residency policy (${allowed}) denies it. Use the upstream provider directly if its region is what you need.`,
    }
  }

  return {
    ...base,
    allowed: false,
    reason: `Provider "${providerID}" processes in "${claim.region}", which the residency policy does not allow (${allowed}).`,
  }
}

/** Thrown when a provider is denied. Message is the decision's reason, so users see why. */
export class DeniedError extends Error {
  readonly decision: Decision
  constructor(decision: Decision) {
    super(`Blocked by data-residency policy. ${decision.reason}`)
    this.name = "ResidencyDeniedError"
    this.decision = decision
  }
}

/** A single outbound model call, as written to the audit log. */
export interface EgressRecord {
  readonly timestamp: string
  readonly providerID: string
  readonly region: Jurisdiction.Region
  readonly basis: Jurisdiction.Basis
  readonly host: string
  readonly allowed: boolean
}

/**
 * Build an audit record for one outbound call.
 *
 * Records the destination host but never the request body — an audit trail of what left and
 * where it went must not itself become a copy of the data that left.
 */
export function record(providerID: string, url: string, allowed: boolean, now = new Date()): EgressRecord {
  const claim = Jurisdiction.lookup(providerID)
  return {
    timestamp: now.toISOString(),
    providerID,
    region: claim.region,
    basis: claim.basis,
    host: safeHost(url),
    allowed,
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "unknown"
  }
}

/** Serialise a record as one JSON line, the format the audit log appends. */
export function line(entry: EgressRecord): string {
  return JSON.stringify(entry) + "\n"
}

/** A residency block as it appears in config, whichever config schema decoded it. */
export interface ConfigBlock {
  readonly allow: readonly Jurisdiction.Region[]
  readonly audit?: boolean
  readonly auditPath?: string
}

export interface Resolved {
  readonly policy: Policy
  readonly audit: boolean
  readonly auditPath: string | undefined
  /** false: record every call but refuse nothing (the XCOD-103 audit trail without a residency policy). */
  readonly enforce?: boolean
}

/** Audit without enforcement: `audit.enabled` set and no residency policy (XCOD-103). */
export function observe(auditPath: string | undefined): Resolved {
  return { policy: { allow: [] }, audit: true, auditPath, enforce: false }
}

/** `undefined` when no policy is configured, which means no enforcement and no logging at all. */
export function resolve(block: ConfigBlock | undefined): Resolved | undefined {
  if (!block) return undefined
  // Audit is on by default once a policy exists, so enabling residency does not silently skip
  // the record of what actually left.
  return { policy: { allow: block.allow }, audit: block.audit ?? true, auditPath: block.auditPath }
}

// XCOD-103: egress records go into the one audit stream (core/audit.ts). The v0 fields keep their
// names; the writer adds `v`, `event`, `seq` and the hash chain. Share uploads use a `share:`
// provider id, so they get the share events.
function append(file: string, entry: EgressRecord) {
  const share = entry.providerID.startsWith("share:")
  const event = share
    ? entry.allowed
      ? "share.upload"
      : "share.denied"
    : entry.allowed
      ? "model.call"
      : "model.denied"
  void Audit.write({ file }, event, { ...entry })
}

/** Record one call in the audit log, if auditing is on. For callers that don't go through a fetch wrapper. */
export function audit(resolved: Resolved, defaultAuditPath: string, providerID: string, url: string, allowed: boolean) {
  if (!resolved.audit) return
  append(resolved.auditPath ?? defaultAuditPath, record(providerID, url, allowed))
}

type Fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

/**
 * Apply a resolved policy to one provider's SDK options, before the SDK is built.
 *
 * Denied: records the refusal (an audit trail that only lists successful calls cannot answer
 * "did anything try to leave the region?") and throws `DeniedError`. Allowed with auditing on:
 * returns a fetch that records each outbound call's host and then delegates to `inner`.
 * Otherwise returns `inner` unchanged.
 */
export function enforce(input: {
  readonly providerID: string
  readonly baseURL: string
  readonly resolved: Resolved
  readonly defaultAuditPath: string
  readonly fetch: Fetch | undefined
}): Fetch | undefined {
  const { providerID, resolved } = input
  const file = resolved.auditPath ?? input.defaultAuditPath
  const decision = evaluate(providerID, resolved.policy)
  if (!decision.allowed && resolved.enforce !== false) {
    if (resolved.audit) append(file, record(providerID, input.baseURL, false))
    throw new DeniedError(decision)
  }
  if (!resolved.audit) return input.fetch
  const inner = input.fetch
  return async (request, init) => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : (request as Request).url
    append(file, record(providerID, url, true))
    return (inner ?? fetch)(request, init)
  }
}
