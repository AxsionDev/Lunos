export * as WorkflowsBlocker from "./workflows-blocker"

import { Wildcard } from "./util/wildcard"

/**
 * XCOD-326 / XCOD-330: why Dynamic workflows can't run for an agent although the setting is on,
 * because no subagent that can edit may be dispatched. The server's `DynamicWorkflows.decide` and the
 * TUI's footer both read this, so the footer, the turn's notice and `/workflows` give the same answer.
 */

type Rule = { permission: string; pattern: string; action: string }
type Ruleset = readonly Rule[]

export type Why = "depth" | "task" | "edit"

/** The full reason, as the notice and `/workflows` say it. */
export function reason(why: Why, input: { agent: string; depth: number }) {
  return {
    depth: `"subagent_depth" is ${input.depth}, so no subagent can be dispatched`,
    task: `a permission rule denies the task tool to the ${input.agent} agent, so no subagent can be dispatched`,
    edit: "every subagent it may dispatch has edit turned off, so none can do the work",
  }[why]
}

/** How to fix it, as the notice says it. */
export function fix(why: Why) {
  return {
    depth: `set "subagent_depth" to 1 or more`,
    task: `allow "task" for a subagent that can edit, such as general, in "permission"`,
    edit: `allow "edit" for a subagent, such as general, or add a subagent that can edit`,
  }[why]
}

/** The footer's short form. */
export function short(why: Why, input: { depth: number }) {
  return {
    depth: `subagent_depth ${input.depth}`,
    task: "task denied",
    edit: "no subagent can edit",
  }[why]
}

/** The same lookup as the server's `Permission.evaluate`: the last matching rule wins. */
function denies(permission: string, pattern: string, ruleset: Ruleset) {
  const rule = ruleset.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return rule?.action === "deny"
}

/** The same test as the server's `Permission.disabled(["edit"], …)`: edit denied outright. */
function editOff(ruleset: Ruleset) {
  const rule = ruleset.findLast((rule) => Wildcard.match("edit", rule.permission))
  return rule?.pattern === "*" && rule.action === "deny"
}

/** Why no subagent that can edit may be dispatched, or undefined when one may. */
export function subagents(input: {
  agent: { permission: Ruleset }
  session?: Ruleset
  subagents: readonly { name: string; permission: Ruleset }[]
}): "task" | "edit" | undefined {
  const ruleset = [...input.agent.permission, ...(input.session ?? [])]
  const dispatchable = input.subagents.filter((subagent) => !denies("task", subagent.name, ruleset))
  if (!dispatchable.length) return "task"
  if (dispatchable.every((subagent) => editOff(subagent.permission))) return "edit"
}

/** Everything that stops a Dynamic workflow once the setting is on: the depth first, then the subagents. */
export function blocker(input: {
  depth: number
  agent: { permission: Ruleset }
  session?: Ruleset
  subagents: readonly { name: string; permission: Ruleset }[]
}): Why | undefined {
  if (input.depth < 1) return "depth"
  return subagents(input)
}
