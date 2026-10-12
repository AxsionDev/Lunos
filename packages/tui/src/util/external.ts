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
