export * as SkillScope from "./scope"

import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

/**
 * Which skills are active in a session, and the tool restriction they impose (XCOD-83).
 *
 * **Active** means: from the moment the `skill` tool loads the skill until the end of that
 * turn. The next user message starts a fresh turn with no active skills. That is the lifetime
 * of the instructions themselves: the skill's text arrives as that turn's tool output.
 *
 * A skill's `allowed-tools` is enforced through the permission system, not beside it:
 * `rules()` returns deny-all plus allow-listed rules. Those rules are merged into the ruleset
 * the model's tool list is filtered with (`Permission.disabled`) and the ruleset `ctx.ask`
 * evaluates, so a disallowed tool is neither offered to the model nor able to run.
 */

type Active = { turn: string; skills: { name: string; allowed?: readonly string[] }[] }

const sessions = new Map<string, Active>()

// Claude Code writes `allowed-tools: Read, Grep, Glob` (or a YAML list). Lunos tool ids are the
// lower-case names, so both forms map onto the same ids.
export function parseAllowedTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : undefined
  if (!items) return undefined
  const tools = items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(tools)]
}

/** Record that `name` was loaded in this session during the turn started by `turn` (a user message id). */
export function activate(sessionID: string, turn: string, skill: { name: string; allowed?: readonly string[] }) {
  const current = sessions.get(sessionID)
  const base = current && current.turn === turn ? current.skills.filter((item) => item.name !== skill.name) : []
  sessions.set(sessionID, { turn, skills: [...base, skill] })
}

/** Skills active in `sessionID` for the turn started by `turn`. Older turns' skills have expired. */
export function active(sessionID: string, turn?: string) {
  const current = sessions.get(sessionID)
  if (!current) return []
  if (turn !== undefined && current.turn !== turn) {
    sessions.delete(sessionID)
    return []
  }
  return current.skills
}

/**
 * Permission rules for the active skills' `allowed-tools`. Every restricting skill must allow a
 * tool for it to stay available (the intersection), and `skill` itself stays available so the
 * model can still load further instructions.
 */
export function rules(sessionID: string, turn?: string): PermissionV1.Rule[] {
  const restricting = active(sessionID, turn).filter((skill) => skill.allowed !== undefined)
  if (!restricting.length) return []
  const allowed = restricting
    .map((skill) => new Set(skill.allowed))
    .reduce((acc, set) => new Set([...acc].filter((tool) => set.has(tool))))
  allowed.add("skill")
  const permissionFor = (tool: string) =>
    ["edit", "write", "apply_patch"].includes(tool)
      ? "edit"
      : ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(tool)
        ? "read"
        : tool
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...[...allowed].map((tool) => ({ permission: permissionFor(tool), pattern: "*", action: "allow" as const })),
  ]
}

/** For tests. */
export function reset() {
  sessions.clear()
}
