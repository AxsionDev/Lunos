// XCOD-303: the footer's "Dynamic workflows: on/off". The same order as the server's
// `DynamicWorkflows.decide` (session/workflows.ts): an organisation lock, then `/workflows on|off`
// in this session (session metadata), then the agent's own `dynamic: false`, then
// `workflows.dynamic` in config, then on. XCOD-326: every primary agent but Plan, and off with
// `subagent_depth: 0`. XCOD-330: and off, with a short reason, when the task tool is denied or every
// subagent the agent may dispatch has edit turned off: the same check as the server's notice and
// `/workflows` (WorkflowsBlocker), so the three agree.

import { WorkflowsBlocker } from "@opencode-ai/core/workflows-blocker"

type Ruleset = readonly { permission: string; pattern: string; action: string }[]

/** The part of a user message that carries the server's "Dynamic workflows are off" notice. */
export const NOTICE = "workflows_notice"

function locked(list: readonly string[] | undefined) {
  return !!list?.some((entry) => entry === "workflows" || entry === "workflows.dynamic")
}

/**
 * "Dynamic workflows: on · main agent orchestrating", with 🔒 when the organisation holds it;
 * undefined in Plan, a subagent's session, or for a subagent.
 */
export function workflowsLabel(input: {
  agent: string | undefined
  /** The agent's mode; a subagent never orchestrates. */
  mode?: string
  config: {
    $locked?: readonly string[]
    workflows?: { dynamic?: boolean }
    subagent_depth?: number
    agent?: Record<string, { dynamic?: boolean } | undefined>
  }
  metadata: Record<string, unknown> | undefined
  child?: boolean
  /** The current agent's permission rules; with `subagents`, decides whether any subagent can do the work. */
  permission?: Ruleset
  /** The session's own permission rules. */
  session?: Ruleset
  /** Every agent that isn't primary, as the server lists them. */
  subagents?: readonly { name: string; permission: Ruleset }[]
  /** A narrow terminal: "Dynamic workflows: on" alone. */
  narrow?: boolean
}) {
  if (input.child || !input.agent || input.agent === "plan" || input.mode === "subagent") return
  const configured = input.config.workflows?.dynamic
  const session = (input.metadata?.workflows as { dynamic?: unknown } | undefined)?.dynamic
  const lock = locked(input.config.$locked)
  const own = input.config.agent?.[input.agent]?.dynamic === false ? false : configured
  const setting = lock ? (configured ?? true) : typeof session === "boolean" ? session : (own ?? true)
  const depth = input.config.subagent_depth ?? 1
  const why = !setting
    ? undefined
    : input.permission && input.subagents
      ? WorkflowsBlocker.blocker({
          depth,
          agent: { permission: input.permission },
          session: input.session,
          subagents: input.subagents,
        })
      : depth < 1
        ? ("depth" as const)
        : undefined
  const state = !setting
    ? "off"
    : why
      ? `off · ${WorkflowsBlocker.short(why, { depth })}`
      : input.narrow
        ? "on"
        : "on · main agent orchestrating"
  return `Dynamic workflows: ${state}${lock ? " 🔒" : ""}`
}
