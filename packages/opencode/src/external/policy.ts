export * as ExternalPolicy from "./policy"

import { Audit } from "@opencode-ai/core/audit"
import { Residency } from "@opencode-ai/core/residency"
import { AuditLog } from "@/audit/log"
import { ExternalDetect } from "./detect"

/**
 * XCOD-204: whether an external session may start, checked before the tool is spawned.
 *
 * - `external.enabled: false` (lockable with `$locked`) turns the feature off.
 * - Residency: these tools send code to their vendor's API, so the tool counts as its vendor's
 *   provider (Claude Code → anthropic, Codex → openai), whatever endpoint the user configured in
 *   the tool itself, which Lunos can't see. Under an EU-only policy both are refused.
 *
 * A refusal is written to the audit log (`external.denied`) like a refused model call.
 */

export class RefusedError extends Error {
  override name = "ExternalRefused"
}

type Config = Parameters<typeof AuditLog.residency>[0] & {
  external?: { enabled?: boolean }
  $locked?: readonly string[]
}

function auditFile(config: Config) {
  const residency = AuditLog.residency(config)
  if (residency?.audit) return residency.auditPath ?? AuditLog.DEFAULT_FILE()
  const settings = AuditLog.resolve(config)
  return settings.enabled ? settings.file : undefined
}

export function record(
  config: Config,
  event: "external.session" | "external.denied" | "external.bridge" | "external.consent" | "external.config",
  fields: Audit.Fields,
) {
  const file = auditFile(config)
  if (file) void Audit.write({ file }, event, fields)
}

export type Refusal = { reason: "disabled" | "policy" | "residency"; message: string }

/**
 * Why a session with `tool` must not start, if it mustn't. Nothing is audited: XCOD-250's commands
 * ask this to grey themselves out, and only an attempt to start (`check`) is recorded.
 */
export function evaluate(tool: ExternalDetect.Tool, config: Config): Refusal | undefined {
  const spec = ExternalDetect.TOOLS[tool]
  if (config.external?.enabled === false) {
    const locked = config.$locked?.some((key) => key === "external" || key === "external.enabled")
    return locked
      ? {
          reason: "policy",
          message: `Starting ${spec.label} from Lunos is turned off by your organisation's policy (external.enabled is locked).`,
        }
      : { reason: "disabled", message: `Starting ${spec.label} from Lunos is turned off (external.enabled is false).` }
  }
  const resolved = AuditLog.residency(config)
  if (resolved && resolved.enforce !== false) {
    const decision = Residency.evaluate(spec.provider, resolved.policy)
    if (!decision.allowed)
      return {
        reason: "residency",
        message: `${spec.label} sends your code to ${spec.provider === "anthropic" ? "Anthropic" : "OpenAI"} (${decision.region}), and the data-residency policy allows only: ${resolved.policy.allow.join(", ")}. It can't be started from Lunos under this policy.`,
      }
  }
}

/** Throws RefusedError (after auditing it) when the session must not start. */
export function check(tool: ExternalDetect.Tool, config: Config) {
  const refusal = evaluate(tool, config)
  if (!refusal) return
  record(config, "external.denied", { tool, provider: ExternalDetect.TOOLS[tool].provider, reason: refusal.reason })
  throw new RefusedError(refusal.message)
}
