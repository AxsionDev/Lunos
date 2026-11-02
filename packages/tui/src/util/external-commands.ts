// XCOD-254: Lunos's commands inside a Claude Code / Codex session. The tool's own commands keep
// their bare names and go to it as typed; Lunos's custom commands, skills and MCP prompts are
// expanded by Lunos (template, arguments, @file) and the result goes to the tool. On a clash the
// Lunos one is `/<name>:lunos`.

export const LUNOS_SUFFIX = ":lunos"

/**
 * Lunos app commands that act on a Lunos agent, mode or model provider, so mean nothing in a session
 * the tool runs. They're shown greyed with the reason and never sent to the tool as text.
 */
export const UNAVAILABLE = new Set(["agents", "modes", "providers", "variants"])

/**
 * XCOD-254: Lunos app commands that act on the tool's session instead: `/models` lists the tool's
 * models, `/cost` shows the cost it reported. Typed in full they're handled by Lunos, never sent as text.
 */
export const MAPPED = new Set(["models", "cost"])

/**
 * The rows of /models in an external session. The empty value is the tool's own default (no `--model`):
 * Claude Code's `default` entry where it lists one, otherwise a "Default" row first.
 */
export function externalModelOptions(
  models: readonly { id: string; name: string; description?: string; default?: boolean }[],
  tool: string,
) {
  const rows = models.map((model) => ({
    value: model.id === "default" ? "" : model.id,
    title: model.name,
    description: [model.description, model.default && model.id !== "default" ? "default" : undefined]
      .filter(Boolean)
      .join(" · "),
  }))
  if (models.some((model) => model.id === "default")) return rows
  return [{ value: "", title: "Default", description: `${tool}'s own default` }, ...rows]
}

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
