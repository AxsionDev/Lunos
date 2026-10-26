export * as DynamicWorkflows from "./workflows"

import path from "path"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigPolicy } from "@/config/policy"
import { Permission } from "@/permission"
import { AuditLog } from "@/audit/log"

/**
 * XCOD-303: Dynamic workflows. With it on (the default), the main agent of every top-level working
 * session is an orchestrator: it plans, dispatches subagents for the work, integrates their results
 * and has a separate `qa` subagent verify. Its own tools are coordination only (`ALLOWED`), and its
 * reads are for orchestration (`READS`, at most `workflows.main_reads` per turn); everything that
 * edits, writes, runs a command or explores the code is done by a subagent.
 *
 * Order, strongest first:
 * 1. An organisation lock on `workflows.dynamic` (managed config's value, or the default when it
 *    leaves it unset). `/workflows` can't override it.
 * 2. `/workflows on|off` in this session (`session.metadata.workflows.dynamic`).
 * 3. `"dynamic": false` in the agent's own definition (XCOD-326).
 * 4. `workflows.dynamic` in config (project over user, as config already merges).
 * 5. On.
 *
 * XCOD-326: it applies to every top-level session whose agent is a primary one (Build, Dev-Cycle,
 * Research, a custom primary agent, `default_agent`), except Plan, which dispatches read-only
 * subagents only. It needs a subagent that can write: with none, it is off and the turn says so
 * (`notice`), never silently.
 */

export const KEY = "workflows.dynamic"
/** The main agent's reads per turn, by default (XCOD-326). */
export const MAIN_READS = 5
/** Where the setting is documented: the notice links to it. */
export const DOCS = "https://docs.lunos.tech/docs/agents/#dynamic-workflows"

export type By = "lock" | "session" | "agent" | "config" | "default" | "mode" | "subagents"
export type Decision = { on: boolean; by: By; reason: string; locked: boolean; fix?: string }

type Config = {
  $locked?: ReadonlyArray<string>
  workflows?: { dynamic?: boolean; main_reads?: number }
  subagent_depth?: number
  agent?: Readonly<Record<string, { dynamic?: boolean } | undefined>>
}
type Agent = { name: string; mode?: string; hidden?: boolean; permission: PermissionV1.Ruleset }

/** Whether this agent's sessions orchestrate at all: a primary agent other than Plan, unless it opts out. */
export function applies(agent: Pick<Agent, "name" | "mode" | "hidden">) {
  return agent.mode !== "subagent" && !agent.hidden && agent.name !== "plan"
}

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
  return !blocker(input)
}

/** Why no subagent that can edit may be dispatched, or undefined when one may. */
function blocker(input: {
  agent: { permission: PermissionV1.Ruleset }
  session?: PermissionV1.Ruleset
  subagents: readonly { name: string; permission: PermissionV1.Ruleset }[]
}) {
  const ruleset = Permission.merge(input.agent.permission, input.session ?? [])
  const dispatchable = input.subagents.filter(
    (subagent) => Permission.evaluate("task", subagent.name, ruleset).action !== "deny",
  )
  if (!dispatchable.length) return "task" as const
  if (dispatchable.every((subagent) => Permission.disabled(["edit"], subagent.permission).has("edit")))
    return "edit" as const
}

/** Whether this turn runs as a Dynamic workflow. */
export function decide(input: {
  config: Config
  agent: Agent
  session: { parentID?: string; metadata?: Record<string, unknown>; permission?: PermissionV1.Ruleset }
  subagents: readonly { name: string; permission: PermissionV1.Ruleset }[]
}): Decision {
  const base = setting({ config: input.config, session: sessionValue(input.session.metadata) })
  if (!base.on) return base
  if (input.session.parentID || !applies(input.agent))
    return {
      on: false,
      by: "mode",
      locked: base.locked,
      reason: "only a top-level session of a primary agent other than Plan runs Dynamic workflows",
    }
  if (!base.locked && base.by !== "session" && input.config.agent?.[input.agent.name]?.dynamic === false)
    return {
      on: false,
      by: "agent",
      locked: false,
      reason: `"agent": { "${input.agent.name}": { "dynamic": false } }`,
    }
  const depth = input.config.subagent_depth ?? 1
  const why =
    depth < 1
      ? ("depth" as const)
      : blocker({ agent: input.agent, session: input.session.permission, subagents: input.subagents })
  if (why)
    return {
      on: false,
      by: "subagents",
      locked: base.locked,
      reason: {
        depth: `"subagent_depth" is ${depth}, so no subagent can be dispatched`,
        task: `a permission rule denies the task tool to the ${input.agent.name} agent, so no subagent can be dispatched`,
        edit: "every subagent it may dispatch has edit turned off, so none can do the work",
      }[why],
      fix: {
        depth: `set "subagent_depth" to 1 or more`,
        task: `allow "task" for a subagent that can edit, such as general, in "permission"`,
        edit: `allow "edit" for a subagent, such as general, or add a subagent that can edit`,
      }[why],
    }
  return base
}

/**
 * XCOD-326: what the turn shows when Dynamic workflows are on but can't run, so it never turns off
 * silently. Undefined otherwise.
 */
export function notice(decision: Decision) {
  if (decision.by !== "subagents") return
  return `Dynamic workflows are off for this session: ${decision.reason}. Fix: ${decision.fix}. The main agent does the work itself until then. See ${DOCS}`
}

/** Marks the notice's part on the user message, so it is added once and kept out of recall. */
export const NOTICE = "workflows_notice"

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

/**
 * XCOD-326: the allowed tools that read or explore. They share one budget per turn
 * (`workflows.main_reads`); past it they refuse with `READ_REFUSAL`, so the code is explored by a
 * subagent. todo, question, task, skill and memory calls stay unlimited.
 */
export const READS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "project_resources_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
])

/** The main agent's reads per turn: `workflows.main_reads`, else `MAIN_READS`. */
export function mainReads(config: Config) {
  return config.workflows?.main_reads ?? MAIN_READS
}

type Message = {
  info: { role: string }
  parts: readonly { type: string; tool?: string; synthetic?: boolean; ignored?: boolean }[]
}

/**
 * The reads the main agent has made this turn: since the last message the user typed (an
 * auto-continue or a subagent's result arriving doesn't start a new turn).
 */
export function readsUsed(messages: readonly Message[]) {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.info.role === "user") {
      if (message.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored)) break
      continue
    }
    for (const part of message.parts) if (part.type === "tool" && READS.has(part.tool ?? "")) count++
  }
  return count
}

/** Edit tools Dev-Cycle and Research keep, for their own file only. */
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
 * Drop every tool but `ALLOWED` from a request's tools. Dev-Cycle and Research keep
 * edit/write/apply_patch for their own file (`allowFile`, resolved against `directory`); a call for
 * any other file is refused with a pointer to dispatching a subagent. A call the model makes anyway
 * to a dropped tool reaches `invalid`, and is refused too. Each refusal is audited as
 * `workflows.main_tool_refused` (XCOD-326). With `reads`, the `READS` tools refuse past
 * `reads.limit` calls this turn, `reads.used` of them already made. Returns the names dropped.
 */
export function gate(
  tools: Record<string, Executable>,
  options: {
    allowFile?: string
    directory: string
    reads?: { used: number; limit: number }
    session?: string
    agent?: string
  } = { directory: process.cwd() },
) {
  const dropped: string[] = []
  const refuse = (tool: string, message: string): never => {
    AuditLog.emit("workflows.main_tool_refused", {
      tool,
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.session ? { session: options.session } : {}),
    })
    throw new Error(message)
  }
  let reads = options.reads?.used ?? 0
  for (const name of Object.keys(tools)) {
    if (ALLOWED.has(name)) {
      const tool = tools[name]!
      const execute = tool.execute
      if (!execute) continue
      if (name === "invalid")
        tool.execute = (args: { tool?: unknown }, opts: unknown) => {
          const called = typeof args?.tool === "string" ? args.tool.toLowerCase() : ""
          if (dropped.includes(called)) refuse(called, REFUSAL)
          return execute(args, opts)
        }
      else if (options.reads && READS.has(name)) {
        const limit = options.reads.limit
        tool.execute = (args: unknown, opts: unknown) => {
          if (++reads > limit) throw new Error(READ_REFUSAL(limit))
          return execute(args, opts)
        }
      }
      continue
    }
    if (options.allowFile && FILE_TOOLS.includes(name)) {
      const tool = tools[name]!
      const execute = tool.execute
      if (!execute) continue
      const allowed = path.resolve(options.directory, options.allowFile)
      tool.execute = (args: unknown, opts: unknown) => {
        const files = targets(name, args)
        if (files.length && files.every((file) => path.resolve(options.directory, file) === allowed))
          return execute(args, opts)
        return refuse(name, REFUSAL)
      }
      continue
    }
    delete tools[name]
    dropped.push(name)
  }
  return dropped
}

export const REFUSAL =
  "Dynamic workflows are on: the main agent doesn't edit files or run commands (Dev-Cycle and Research edit their own cycle or research file only). Dispatch a subagent with the task tool to do it."

/** XCOD-326: what a read past the main agent's budget is told. */
export const READ_REFUSAL = (limit: number) =>
  `Dynamic workflows are on: the main agent's ${limit} reads for this turn are used. To read or search the code, dispatch an explore subagent with the task tool and have it report what you need.`

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
