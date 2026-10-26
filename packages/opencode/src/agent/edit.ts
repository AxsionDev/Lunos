export * as AgentEdit from "./edit"

import { Exit, Schema } from "effect"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { AgentFile } from "./file"

/**
 * Editing an agent (XCOD-210): `lunos agent edit` and the TUI's /agents screen change an agent's
 * file through `change` and `validate`, so a save that names a model, tool or skill that doesn't
 * exist here is refused with every problem listed, and nothing is written.
 */

export type Action = "allow" | "ask" | "deny"

export interface Changes {
  description?: string
  prompt?: string
  model?: string | null
  mode?: "primary" | "subagent" | "all"
  steps?: number | null
  hidden?: boolean
  color?: string | null
  /** Permission rules to set, by permission (`bash`, `webfetch`, `github_search`, …). */
  permission?: Record<string, Action>
  /** Skills the agent may load (`skill: { <name>: allow }`), or may not. */
  skills?: Record<string, Action>
  /** MCP servers whose tools the agent may use (`<server>_*`). */
  mcp?: Record<string, Action>
}

/** What exists here to check an agent against. */
export interface Known {
  models: ReadonlySet<string>
  /** Tool ids and permission names (`read`, `bash`, `external_directory`, …). */
  tools: ReadonlySet<string>
  skills: ReadonlySet<string>
  mcp: ReadonlySet<string>
}

/** Permission names Lunos uses that aren't tool ids. */
export const PERMISSIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
  "memory",
]

export function change(doc: AgentFile.Doc, changes: Changes): AgentFile.Doc {
  const next: AgentFile.Doc = { ...doc }
  const set = (key: string, value: unknown) => {
    if (value === undefined) return
    if (value === null) delete next[key]
    else next[key] = value
  }
  set("description", changes.description)
  set("prompt", changes.prompt)
  set("model", changes.model)
  set("mode", changes.mode)
  set("steps", changes.steps)
  set("hidden", changes.hidden)
  set("color", changes.color)

  if (changes.permission || changes.skills || changes.mcp) {
    const permission: Record<string, unknown> =
      typeof next.permission === "string"
        ? { "*": next.permission }
        : { ...((next.permission as Record<string, unknown>) ?? {}) }
    // Rules match last-wins: a rule set here goes after everything already there.
    const put = (key: string, value: unknown) => {
      delete permission[key]
      permission[key] = value
    }
    for (const [key, action] of Object.entries(changes.permission ?? {})) put(key, action)
    for (const [server, action] of Object.entries(changes.mcp ?? {})) put(`${server}_*`, action)
    if (changes.skills) {
      const current = permission.skill
      const skill: Record<string, unknown> =
        typeof current === "string" ? { "*": current } : { ...((current as Record<string, unknown>) ?? {}) }
      for (const [name, action] of Object.entries(changes.skills)) {
        delete skill[name]
        skill[name] = action
      }
      put("skill", skill)
    }
    next.permission = permission
  }
  return next
}

/** Every problem with an agent definition here, or none. */
export function validate(doc: AgentFile.Doc, known: Known): string[] {
  const problems: string[] = []
  const decoded = Schema.decodeUnknownExit(ConfigAgentV1.Info)(doc)
  if (Exit.isFailure(decoded))
    problems.push("the definition isn't a valid agent (check the front matter's fields and types)")

  if (doc.model !== undefined) {
    if (typeof doc.model !== "string" || !doc.model.includes("/"))
      problems.push(`model "${String(doc.model)}" isn't in provider/model form`)
    else if (!known.models.has(doc.model))
      problems.push(`model "${doc.model}" isn't available here (see \`lunos models\`)`)
  }

  const permission = doc.permission
  if (permission && typeof permission === "object") {
    for (const [key, value] of Object.entries(permission as Record<string, unknown>)) {
      if (!knownPermission(key, known)) problems.push(`permission "${key}" doesn't match any tool or MCP server here`)
      if (key === "skill" && value && typeof value === "object")
        for (const name of Object.keys(value))
          if (!name.includes("*") && !name.includes("?") && !known.skills.has(name))
            problems.push(`skill "${name}" isn't installed here`)
    }
  }
  return problems
}

function knownPermission(key: string, known: Known) {
  if (key.includes("*") || key.includes("?")) {
    // A wildcard is fine when it reaches something, a tool or an MCP server's tools.
    return (
      [...known.tools, ...PERMISSIONS].some((tool) => Wildcard.match(tool, key)) ||
      [...known.mcp].some((server) => Wildcard.match(`${server}_x`, key))
    )
  }
  if (known.tools.has(key) || PERMISSIONS.includes(key)) return true
  return [...known.mcp].some((server) => key.startsWith(`${server}_`))
}
