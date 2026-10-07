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

export function record(config: Config, event: "external.session" | "external.denied", fields: Audit.Fields) {
  const file = auditFile(config)
  if (file) void Audit.write({ file }, event, fields)
}

/** Throws RefusedError (after auditing it) when the session must not start. */
export function check(tool: ExternalDetect.Tool, config: Config) {
  const spec = ExternalDetect.TOOLS[tool]
  const refuse = (reason: string, why: string) => {
    record(config, "external.denied", { tool, provider: spec.provider, reason })
    throw new RefusedError(why)
  }
  if (config.external?.enabled === false) {
    const locked = config.$locked?.some((key) => key === "external" || key === "external.enabled")
    refuse(
      locked ? "policy" : "disabled",
      locked
        ? `Starting ${spec.label} from Lunos is turned off by your organisation's policy (external.enabled is locked).`
        : `Starting ${spec.label} from Lunos is turned off (external.enabled is false).`,
    )
  }
  const resolved = AuditLog.residency(config)
  if (resolved && resolved.enforce !== false) {
    const decision = Residency.evaluate(spec.provider, resolved.policy)
    if (!decision.allowed)
      refuse(
        "residency",
        `${spec.label} sends your code to ${spec.provider === "anthropic" ? "Anthropic" : "OpenAI"} (${decision.region}), and the data-residency policy allows only: ${resolved.policy.allow.join(", ")}. It can't be started from Lunos under this policy.`,
      )
  }
}
