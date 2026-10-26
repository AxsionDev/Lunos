export * as DynamicWorkflows from "./workflows"

import path from "path"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigPolicy } from "@/config/policy"
import { Permission } from "@/permission"

/**
 * XCOD-303: Dynamic workflows. With it on (the default), the main Build or Dev-Cycle agent is an
 * orchestrator: it plans, dispatches subagents for the work, integrates their results and has a
 * separate `qa` subagent verify. Its own tools are coordination only (`ALLOWED`); everything that
 * edits, writes or runs a command is done by a subagent.
 *
 * Order, strongest first:
 * 1. An organisation lock on `workflows.dynamic` (managed config's value, or the default when it
 *    leaves it unset). `/workflows` can't override it.
 * 2. `/workflows on|off` in this session (`session.metadata.workflows.dynamic`).
 * 3. `workflows.dynamic` in config (project over user, as config already merges).
 * 4. On.
 *
 * It applies to a top-level Build or Dev-Cycle session only, and only while that agent may dispatch
 * a subagent that can write: with no such subagent it would be left unable to do anything, so it
 * falls back to off and says why.
 */

export const KEY = "workflows.dynamic"
export const MODES = ["build", "dev-cycle"] as const

export type By = "lock" | "session" | "config" | "default" | "mode" | "subagents"
export type Decision = { on: boolean; by: By; reason: string; locked: boolean }

type Config = { $locked?: ReadonlyArray<string>; workflows?: { dynamic?: boolean }; subagent_depth?: number }

/** What `/workflows on|off` recorded on the session, if anything. */
export function sessionValue(metadata: Record<string, unknown> | undefined): boolean | undefined {
  const value = (metadata?.workflows as { dynamic?: unknown } | undefined)?.dynamic
  return typeof value === "boolean" ? value : undefined
}

/** The session's metadata with `/workflows on|off` recorded (or cleared, for `undefined`). */
export function withSessionValue(metadata: Record<string, unknown> | undefined, value: boolean | undefined) {
  const { workflows: _, ...rest } = metadata ?? {}
  return value === undefined ? rest : { ...rest, workflows: { dynamic: value } }
}

/** The setting itself, before the mode and the subagents are looked at: what the footer shows. */
export function setting(input: { config: Config; session?: boolean }): Decision {
  const configured = input.config.workflows?.dynamic
  if (ConfigPolicy.isLocked(input.config.$locked, KEY)) {
    const on = configured ?? true
    return { on, by: "lock", locked: true, reason: `${on ? "on" : "off"}: ${ConfigPolicy.message(KEY)}` }
  }
  if (input.session !== undefined)
    return {
      on: input.session,
      by: "session",
      locked: false,
      reason: `turned ${input.session ? "on" : "off"} with /workflows in this session`,
    }
  if (configured !== undefined)
    return { on: configured, by: "config", locked: false, reason: `"workflows": { "dynamic": ${configured} }` }
  return { on: true, by: "default", locked: false, reason: "on by default" }
}

/** Whether this agent may dispatch at least one subagent that can edit files. */
export function canDispatchWriter(input: {
  agent: { permission: PermissionV1.Ruleset }
  session?: PermissionV1.Ruleset
  subagents: readonly { name: string; permission: PermissionV1.Ruleset }[]
}) {
  const ruleset = Permission.merge(input.agent.permission, input.session ?? [])
  return input.subagents.some(
    (subagent) =>
      Permission.evaluate("task", subagent.name, ruleset).action !== "deny" &&
      !Permission.disabled(["edit"], subagent.permission).has("edit"),
  )
}

/** Whether this turn runs as a Dynamic workflow. */
export function decide(input: {
  config: Config
  agent: { name: string; permission: PermissionV1.Ruleset }
  session: { parentID?: string; metadata?: Record<string, unknown>; permission?: PermissionV1.Ruleset }
  subagents: readonly { name: string; permission: PermissionV1.Ruleset }[]
}): Decision {
  const base = setting({ config: input.config, session: sessionValue(input.session.metadata) })
  if (!base.on) return base
  if (input.session.parentID || !(MODES as readonly string[]).includes(input.agent.name))
    return { on: false, by: "mode", locked: base.locked, reason: "only Build and Dev-Cycle run Dynamic workflows" }
  if (
    (input.config.subagent_depth ?? 1) < 1 ||
    !canDispatchWriter({ agent: input.agent, session: input.session.permission, subagents: input.subagents })
  )
    return {
      on: false,
      by: "subagents",
      locked: base.locked,
      reason: "no subagent that can edit files may be dispatched, so the main agent does the work itself",
    }
  return base
}

/**
 * The main agent's own tools while a Dynamic workflow runs: reading, searching, the todo list, the
 * question tool, dispatching (task), skills and memory. Anything else (edit, write, apply_patch,
 * bash, process, MCP and plugin tools, external agents, code mode) is dropped from the request, so
 * the model can't call it. `invalid` stays so a mistyped call still gets an answer.
 */
export const ALLOWED: ReadonlySet<string> = new Set([
  "invalid",
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "todowrite",
  "todoread",
  "question",
  "task",
  "skill",
  "project_resources_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "memory_search",
  "memory_remember",
  "plan_enter",
  "plan_exit",
])

/** Edit tools Dev-Cycle keeps, for its cycle file only. */
const FILE_TOOLS = ["edit", "write", "apply_patch"]

/** The files an edit, write or apply_patch call would touch, as given (relative or absolute). */
export function targets(tool: string, args: unknown): string[] {
  const input = (args ?? {}) as { filePath?: unknown; patchText?: unknown }
  if (tool === "apply_patch") {
    const text = typeof input.patchText === "string" ? input.patchText : ""
    return [
      ...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
      ...text.matchAll(/^\*\*\* Move to: (.+)$/gm),
    ]
      .map((match) => match[1]!.trim())
      .filter(Boolean)
  }
  return typeof input.filePath === "string" ? [input.filePath] : []
}

type Executable = { execute?: (args: any, options: any) => unknown }

/**
 * Drop every tool but `ALLOWED` from a request's tools. Dev-Cycle keeps edit/write/apply_patch for
 * its own cycle file (`allowFile`, resolved against `directory`); a call for any other file is
 * refused with a pointer to dispatching a subagent. Returns the names dropped.
 */
export function gate(
  tools: Record<string, Executable>,
  options: { allowFile?: string; directory: string } = { directory: process.cwd() },
) {
  const dropped: string[] = []
  for (const name of Object.keys(tools)) {
    if (ALLOWED.has(name)) continue
    if (options.allowFile && FILE_TOOLS.includes(name)) {
      const tool = tools[name]!
      const execute = tool.execute
      if (!execute) continue
      const allowed = path.resolve(options.directory, options.allowFile)
      tool.execute = (args: unknown, opts: unknown) => {
        const files = targets(name, args)
        if (files.length && files.every((file) => path.resolve(options.directory, file) === allowed))
          return execute(args, opts)
        throw new Error(REFUSAL)
      }
      continue
    }
    delete tools[name]
    dropped.push(name)
  }
  return dropped
}

export const REFUSAL =
  "Dynamic workflows are on: the main agent only edits its cycle file. Dispatch a subagent with the task tool to change any other file."

/** Re-dispatches of one step allowed before the user is asked (XCOD-303: "at most 3 re-dispatches"). */
export const MAX_REDISPATCH = 3

type TaskPart = {
  type: string
  tool?: string
  state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> }
}

/**
 * How many times this step was dispatched before, from the session's messages. A step is known by
 * its `task_id` (the same subagent continuing: the call that started it, and every call that passed
 * it) or else by the same agent type and description. 0 for a new step.
 */
export function dispatches(
  messages: readonly { info: { role: string }; parts: readonly TaskPart[] }[],
  call: { subagent_type: string; description: string; task_id?: string },
) {
  let count = 0
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "task") continue
      const input = part.state?.input ?? {}
      const same = call.task_id
        ? input.task_id === call.task_id || part.state?.metadata?.sessionId === call.task_id
        : input.subagent_type === call.subagent_type && input.description === call.description
      if (same) count++
    }
  }
  return count
}
