// XCOD-303: the footer's "Dynamic workflows: on/off". The same order as the server's
// `DynamicWorkflows.decide` (session/workflows.ts): an organisation lock, then `/workflows on|off`
// in this session (session metadata), then the agent's own `dynamic: false`, then
// `workflows.dynamic` in config, then on. XCOD-326: every primary agent but Plan, and off with
// `subagent_depth: 0` (the server's other reasons for off show as a notice on the turn).

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
  /** A narrow terminal: "Dynamic workflows: on" alone. */
  narrow?: boolean
}) {
  if (input.child || !input.agent || input.agent === "plan" || input.mode === "subagent") return
  const configured = input.config.workflows?.dynamic
  const session = (input.metadata?.workflows as { dynamic?: unknown } | undefined)?.dynamic
  const lock = locked(input.config.$locked)
  const own = input.config.agent?.[input.agent]?.dynamic === false ? false : configured
  const setting = lock ? (configured ?? true) : typeof session === "boolean" ? session : (own ?? true)
  const on = setting && (input.config.subagent_depth ?? 1) >= 1
  return `Dynamic workflows: ${on ? (input.narrow ? "on" : "on · main agent orchestrating") : "off"}${lock ? " 🔒" : ""}`
}
