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

/**
 * XCOD-285: one of the tool's own approval choices (Claude Code's "Yes" / "Yes, and don't ask again
 * for …" / "No, and tell Claude what to do differently"; Codex's decisions), as the server builds them
 * from the tool's request (ExternalNative.choices). `reply` is the Lunos reply it sends; `feedback`
 * asks for the text first; `message` goes with the refusal.
 */
export type ExternalChoice = {
  id: string
  label: string
  reply: "once" | "always" | "reject"
  feedback?: boolean
  message?: string
}

/** The choices on an `external` approval, or undefined to keep Lunos's own (an older server sends none). */
export function externalChoices(metadata: Record<string, unknown> | undefined): ExternalChoice[] | undefined {
  const raw = metadata?.["choices"]
  if (!Array.isArray(raw)) return undefined
  const valid = raw.flatMap((item): ExternalChoice[] => {
    if (!item || typeof item !== "object") return []
    const { id, label, reply, feedback, message } = item as Record<string, unknown>
    if (typeof id !== "string" || typeof label !== "string") return []
    if (reply !== "once" && reply !== "always" && reply !== "reject") return []
    return [
      {
        id,
        label,
        reply,
        ...(feedback === true ? { feedback: true } : {}),
        ...(typeof message === "string" && message ? { message } : {}),
      },
    ]
  })
  // Something to allow with and something to refuse with, or it isn't a usable prompt.
  if (!valid.some((item) => item.reply !== "reject") || !valid.some((item) => item.reply === "reject")) return undefined
  return valid
}
