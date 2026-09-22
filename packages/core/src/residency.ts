export * as Residency from "./residency"

import { Jurisdiction } from "./jurisdiction"

/**
 * Data-residency policy evaluation (XCOD-62).
 *
 * Deliberately pure and free of Effect scaffolding: the decision is a function of a provider id
 * and a policy, nothing else. The plugin in `plugin/residency.ts` is the only wiring, so this
 * logic stays directly testable.
 *
 * Enforcement point is `AISDK.language()` by way of the `aisdk.sdk` hook — a hook that throws
 * becomes an `InitError`, so a denied provider never yields a language model. That is request
 * time, not merely selection time: blocking here cannot be bypassed by picking the model
 * through some other surface.
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
