// XCOD-218: external sessions (Claude Code / Codex driven from Lunos) in the TUI.

export type ExternalTool = "claude" | "codex"

export const EXTERNAL_LABEL: Record<ExternalTool, string> = { claude: "Claude Code", codex: "Codex CLI" }

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
