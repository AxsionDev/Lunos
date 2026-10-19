import { createSignal } from "solid-js"
import { prefersReducedMotion } from "./motion"
// XCOD-218: external sessions (Claude Code / Codex driven from Lunos) in the TUI.

export type ExternalTool = "claude" | "codex"

export const EXTERNAL_LABEL: Record<ExternalTool, string> = { claude: "Claude Code", codex: "Codex CLI" }

/**
 * XCOD-260: how an external session names its tool: "▸ Claude Code" before the prompt and
 * "Lunos · Claude Code" bottom right. The products' plain names next to ours, never one co-branded name.
 */
export const EXTERNAL_BADGE: Record<ExternalTool, string> = { claude: "Claude Code", codex: "Codex" }

export function externalBadge(tool: ExternalTool, model?: string) {
  return ["Lunos", EXTERNAL_BADGE[tool], model].filter(Boolean).join(" · ")
}

/**
 * The tool's accent, or undefined to keep the theme's colours: with `tui.external_accent: false`, or
 * under NO_COLOR / TERM=dumb, where the badge and the ▸ label carry the meaning on their own.
 */
export function externalAccent<T>(
  theme: { externalClaude: T; externalCodex: T },
  tool: ExternalTool,
  enabled: boolean,
  env: Record<string, string | undefined> = process.env,
) {
  if (!enabled || prefersReducedMotion(env)) return undefined
  return tool === "claude" ? theme.externalClaude : theme.externalCodex
}

export type ExternalMarker = { tool: ExternalTool; session?: string; commands?: string[] }

/** The marker the server keeps on an external session (`metadata.external`), if this is one. */
export function externalOf(session: { metadata?: Record<string, unknown> } | undefined): ExternalMarker | undefined {
  const value = session?.metadata?.external as ExternalMarker | undefined
  if (!value || (value.tool !== "claude" && value.tool !== "codex")) return undefined
  return value
}

const TOOLS: Record<string, ExternalTool> = { claude: "claude", "claude-code": "claude", codex: "codex" }

/**
 * `/external` arguments: `/external claude`, `/external codex`, or `/external resume <tool> <id>`
 * (also `/external <tool> <id>`). Bare `/external` returns `{ pick: true }` (choose in a dialog).
 */
export function parseExternalSlash(
  input: string,
): { pick: true } | { tool: ExternalTool; session?: string } | { error: string } | undefined {
  const match = /^\/external(?:\s+(.*))?$/.exec(input.trim())
  if (!match) return undefined
  const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { pick: true }
  if (words[0] === "resume") words.shift()
  const tool = TOOLS[words[0]?.toLowerCase() ?? ""]
  const usage = "Usage: /external claude | codex, or /external resume <claude|codex> <session id>"
  if (!tool || words.length > 2) return { error: usage }
  const session = words[1]
  if (session !== undefined && !/^[A-Za-z0-9_-]+$/.test(session)) return { error: `"${session}" isn't a session id` }
  return { tool, ...(session ? { session } : {}) }
}

/**
 * XCOD-250: `/claude <task>` and `/codex <task>`. The text goes to the tool as typed, its own
 * /commands included (`/codex /review`); bare `/claude` or `/codex` opens the session picker.
 */
export function parseToolSlash(input: string): { tool: ExternalTool; text: string } | undefined {
  const match = /^\/(claude|codex)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!match) return undefined
  return { tool: match[1] as ExternalTool, text: (match[2] ?? "").trim() }
}

export type ExternalToolState = {
  installed: boolean
  loggedIn?: boolean
  hint?: string
  refused?: { reason: string; message: string }
}

/**
 * Why a tool's command is greyed out, or undefined when it's ready. A refusal by policy still lets
 * the command be chosen: the server then refuses it with the reason and audits the attempt.
 */
export function toolUnavailable(tool: ExternalTool, state: ExternalToolState | undefined) {
  if (!state) return undefined
  if (state.refused) return state.refused.reason === "residency" ? "blocked by policy" : state.refused.message
  if (!state.installed) return `${EXTERNAL_LABEL[tool]} isn't installed — see lunos external list`
  if (state.loggedIn === false) return `${EXTERNAL_LABEL[tool]} isn't signed in — see lunos external list`
  return undefined
}

// Probing the tools runs `claude --version`, `--help` and `auth status` (and Codex's equivalents),
// so it waits until someone opens the slash commands instead of running on every start.
const [toolsWanted, setToolsWanted] = createSignal(false)
export { toolsWanted }
export function wantExternalTools() {
  if (!toolsWanted()) setToolsWanted(true)
}

/** "$0.3211": the cost the tool reported, to four places like `lunos external`. */
export function externalCost(value: number) {
  return `$${value.toFixed(4)}`
}

/** The reason a refused request gives (a policy or residency refusal comes back as `{ message }`). */
export function refusalMessage(error: unknown, fallback: string) {
  const body = error as { message?: unknown; data?: { message?: unknown } } | undefined
  if (typeof body?.message === "string") return body.message
  if (typeof body?.data?.message === "string") return body.data.message
  return fallback
}
