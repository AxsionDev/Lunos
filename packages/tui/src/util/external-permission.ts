import { ConfigExternal } from "@opencode-ai/core/config/external"

// XCOD-256: the choices /settings offers for Claude Code's permission mode and Codex's sandbox and
// approval policy. The default (manual approval) comes first and is never written; unsafe values
// are listed so they can be found, but only ever passed for one run.

export const KEYS = Object.keys(ConfigExternal.DEFAULTS)

/** Without a readable `claude --help`. */
export const CLAUDE_FALLBACK = ["default", "acceptEdits", "plan"]

export type Choice = {
  value: string
  title: string
  description: string
  /** The default: choosing it removes the key instead of writing it. */
  default?: boolean
  /** Refused in config; shown greyed with how to pass it for one run. */
  unsafe?: boolean
}

export function choices(key: string, detected?: readonly string[], current?: unknown): Choice[] {
  const fallback = ConfigExternal.DEFAULTS[key]
  if (!fallback) return []
  const known: readonly string[] =
    key === "external.claude.permission_mode"
      ? ConfigExternal.CLAUDE_MODES
      : key === "external.codex.sandbox"
        ? ConfigExternal.CODEX_SANDBOXES
        : ConfigExternal.CODEX_APPROVALS
  // Claude Code: what this install accepts (its `manual` is the default under a new name), in Lunos's
  // order, and only values the config schema can hold. Unsafe values are always listed, greyed.
  const offered =
    key === "external.claude.permission_mode"
      ? known.filter(
          (mode) =>
            mode !== fallback &&
            ((detected ?? CLAUDE_FALLBACK).includes(mode) || ConfigExternal.UNSAFE.has(mode)) &&
            (mode !== "manual" || ConfigExternal.value(current) === "manual"),
        )
      : known.filter((value) => value !== fallback)
  return [
    {
      value: fallback,
      title: ConfigExternal.DEFAULT_LABEL,
      description: `${fallback}: ${ConfigExternal.DESCRIPTIONS[fallback]}`,
      default: true,
    },
    ...offered.map((value) => ({
      value,
      title: value,
      description: ConfigExternal.DESCRIPTIONS[value] ?? "",
      ...(ConfigExternal.UNSAFE.has(value) ? { unsafe: true } : {}),
    })),
  ]
}

/** What selecting an unsafe value says instead of saving it. */
export function perRun(value: string) {
  return `Only per run: lunos external run … --permission-mode ${value} --unsafe`
}
