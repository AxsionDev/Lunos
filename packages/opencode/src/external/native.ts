export * as ExternalNative from "./native"

import { ConfigExternal } from "@opencode-ai/core/config/external"
import type { ExternalClaude } from "./claude"
import type { ExternalDetect } from "./detect"

/**
 * XCOD-285: an approval in a Claude Code or Codex session offers the tool's own choices, built from
 * what the tool sent with the request, never a list kept from memory:
 *
 *   Claude Code: "Yes"; "Yes, and don't ask again for …" only when the request carries
 *   `permission_suggestions` (named from them, applied for this session only); "No, and tell Claude
 *   what to do differently", which asks for the feedback. Without feedback the tool's turn stops.
 *   Codex: the app server's decisions for the request (accept, acceptForSession, decline, cancel).
 *
 * Each choice is carried on the Lunos request (`metadata.choices`) and answered with a Lunos reply,
 * so the audit log and Lunos rules work as for any approval. `reply` is the Lunos reply it sends;
 * `feedback` asks for the text first; `message` is sent as the refusal's text.
 */
export interface Choice {
  id: string
  label: string
  reply: "once" | "always" | "reject"
  feedback?: boolean
  message?: string
}

/** The text a Codex decline sends, so Lunos reads it as "refused, carry on" rather than "stop". */
export const DECLINED = "Declined in Lunos; carry on without it."

/** "Bash(npm test:*)": a rule as Claude Code writes it. */
function rule(value: unknown) {
  const item = value as { toolName?: unknown; ruleContent?: unknown } | undefined
  if (typeof item?.toolName !== "string") return undefined
  return typeof item.ruleContent === "string" && item.ruleContent
    ? `${item.toolName}(${item.ruleContent})`
    : item.toolName
}

/** What "don't ask again for …" names, from the tool's suggestions. Undefined when none can be named. */
export function scope(suggestions: readonly ExternalClaude.Suggestion[] | undefined) {
  const parts = (suggestions ?? []).flatMap((item): string[] => {
    if ((item.type === "addRules" || item.type === "replaceRules") && item.behavior !== "deny") {
      const rules = (Array.isArray(item.rules) ? item.rules : []).map(rule).filter((x): x is string => !!x)
      return rules
    }
    if (item.type === "setMode" && typeof item.mode === "string")
      return [item.mode === "acceptEdits" ? "edits in this session (accept edits mode)" : `${item.mode} mode`]
    if (item.type === "addDirectories" && Array.isArray(item.directories))
      return item.directories.filter((dir): dir is string => typeof dir === "string").map((dir) => `files in ${dir}`)
    return []
  })
  return parts.length ? parts.join(", ") : undefined
}

export function choices(tool: ExternalDetect.Tool, request: ExternalClaude.PermissionRequest): Choice[] {
  if (tool === "claude") {
    const named = scope(request.suggestions)
    return [
      { id: "yes", label: "Yes", reply: "once" },
      ...(named ? [{ id: "always", label: `Yes, and don't ask again for ${named}`, reply: "always" as const }] : []),
      { id: "no", label: "No, and tell Claude what to do differently", reply: "reject", feedback: true },
    ]
  }
  const offered = new Set(request.decisions ?? [])
  const all: (Choice & { decision: string })[] = [
    { decision: "accept", id: "accept", label: "Yes", reply: "once" },
    {
      decision: "acceptForSession",
      id: "acceptForSession",
      label: request.tool === "FileChange" ? "Yes, and don't ask again for these files" : "Yes, for this session",
      reply: "always",
    },
    { decision: "decline", id: "decline", label: "No, carry on without it", reply: "reject", message: DECLINED },
    { decision: "cancel", id: "cancel", label: "No, and stop", reply: "reject" },
  ]
  return all.filter((item) => offered.has(item.decision)).map(({ decision: _, ...item }) => item)
}

/**
 * The Lunos `always` patterns for "don't ask again", matched to what the tool was told to allow, so a
 * later turn (a new process of the tool) isn't asked again for the same thing. Claude Code's rule
 * `Bash(npm test:*)` is `claude:Bash npm test*`; a bare tool name is `claude:<Tool> *`. Undefined
 * leaves the default patterns.
 */
export function always(tool: ExternalDetect.Tool, suggestions: readonly ExternalClaude.Suggestion[] | undefined) {
  const patterns = (suggestions ?? []).flatMap((item) => {
    if ((item.type !== "addRules" && item.type !== "replaceRules") || item.behavior === "deny") return []
    return (Array.isArray(item.rules) ? item.rules : []).flatMap((value: unknown) => {
      const entry = value as { toolName?: unknown; ruleContent?: unknown } | undefined
      if (typeof entry?.toolName !== "string") return []
      const content = typeof entry.ruleContent === "string" && entry.ruleContent ? entry.ruleContent : "*"
      return [`${tool}:${entry.toolName} ${content.replace(/:\*$/, "*")}`]
    })
  })
  return patterns.length ? patterns : undefined
}

/** The safe permission mode a "don't ask again" switches to (its `setMode` suggestion), if any. */
export function mode(suggestions: readonly ExternalClaude.Suggestion[] | undefined, unsafe: ReadonlySet<string>) {
  const found = (suggestions ?? []).find((item) => item.type === "setMode" && typeof item.mode === "string")
  const value = found?.mode as string | undefined
  return value && /^[A-Za-z]+$/.test(value) && !unsafe.has(value) ? value : undefined
}

/** XCOD-285: Shift+Tab's cycle lives with the config's modes (ConfigExternal.cycle / next), shared with the TUI. */
export const cycle = ConfigExternal.cycle
export const next = ConfigExternal.next
