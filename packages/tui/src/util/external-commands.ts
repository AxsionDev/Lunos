// XCOD-254: Lunos's commands inside a Claude Code / Codex session. The tool's own commands keep
// their bare names and go to it as typed; Lunos's custom commands, skills and MCP prompts are
// expanded by Lunos (template, arguments, @file) and the result goes to the tool. On a clash the
// Lunos one is `/<name>:lunos`.

export const LUNOS_SUFFIX = ":lunos"

/**
 * Lunos app commands that act on a Lunos agent, mode or model provider, so mean nothing in a session
 * the tool runs. They're shown greyed with the reason and never sent to the tool as text.
 */
export const UNAVAILABLE = new Set(["agents", "modes", "models", "providers", "variants"])

/** The name Lunos's command is offered under in this session: bare, or `name:lunos` on a clash. */
export function lunosName(name: string, own: readonly string[]) {
  return own.includes(name) ? name + LUNOS_SUFFIX : name
}

/**
 * Whether the typed text runs a Lunos command, and which: `/review:lunos …` always does; `/fix …`
 * does when Lunos has a `fix` command and the tool doesn't. Anything else goes to the tool as typed.
 */
export function lunosCommand(input: string, own: readonly string[], lunos: readonly string[]) {
  if (!input.startsWith("/")) return undefined
  const end = input.indexOf("\n")
  const first = end === -1 ? input : input.slice(0, end)
  const [token = "", ...rest] = first.split(" ")
  const typed = token.slice(1)
  const name = typed.endsWith(LUNOS_SUFFIX) ? typed.slice(0, -LUNOS_SUFFIX.length) : typed
  if (!lunos.includes(name)) return undefined
  if (name === typed && own.includes(name)) return undefined
  const args = rest.join(" ") + (end === -1 ? "" : "\n" + input.slice(end + 1))
  return { name, args }
}
