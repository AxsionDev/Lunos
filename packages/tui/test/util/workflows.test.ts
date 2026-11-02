// XCOD-303: the footer's Dynamic workflows indicator follows the server's order.
import { describe, expect, test } from "bun:test"
import { workflowsLabel } from "../../src/util/workflows"

describe("workflowsLabel", () => {
  test("on by default, for every primary agent but Plan", () => {
    expect(workflowsLabel({ agent: "build", config: {}, metadata: undefined })).toBe(
      "Dynamic workflows: on · main agent orchestrating",
    )
    expect(workflowsLabel({ agent: "dev-cycle", config: {}, metadata: undefined })).toBe(
      "Dynamic workflows: on · main agent orchestrating",
    )
    expect(workflowsLabel({ agent: "plan", config: {}, metadata: undefined })).toBeUndefined()
    expect(workflowsLabel({ agent: "build", config: {}, metadata: undefined, child: true })).toBeUndefined()
    // XCOD-326: Research and custom primary agents too; an agent opts out with dynamic: false.
    const on = "Dynamic workflows: on · main agent orchestrating"
    expect(workflowsLabel({ agent: "research", config: {}, metadata: undefined })).toBe(on)
    expect(workflowsLabel({ agent: "reviewer", mode: "primary", config: {}, metadata: undefined })).toBe(on)
    expect(workflowsLabel({ agent: "helper", mode: "subagent", config: {}, metadata: undefined })).toBeUndefined()
    expect(
      workflowsLabel({ agent: "reviewer", config: { agent: { reviewer: { dynamic: false } } }, metadata: undefined }),
    ).toBe("Dynamic workflows: off")
    // Narrow terminals get the short form.
    expect(workflowsLabel({ agent: "build", config: {}, metadata: undefined, narrow: true })).toBe(
      "Dynamic workflows: on",
    )
    // No subagent can be dispatched: off, as the server's notice says.
    expect(workflowsLabel({ agent: "build", config: { subagent_depth: 0 }, metadata: undefined })).toBe(
      "Dynamic workflows: off · subagent_depth 0",
    )
  })

  test("/workflows off in the session beats config; an organisation lock beats both", () => {
    const off = { workflows: { dynamic: false } }
    expect(workflowsLabel({ agent: "build", config: {}, metadata: off })).toBe("Dynamic workflows: off")
    expect(workflowsLabel({ agent: "build", config: { workflows: { dynamic: false } }, metadata: undefined })).toBe(
      "Dynamic workflows: off",
    )
    expect(
      workflowsLabel({
        agent: "build",
        config: { $locked: ["workflows.dynamic"], workflows: { dynamic: true } },
        metadata: off,
      }),
    ).toBe("Dynamic workflows: on · main agent orchestrating 🔒")
  })
})

// XCOD-330: off because no subagent can do the work says so, with the reason, as the notice does.
describe("workflowsLabel: no subagent that can edit", () => {
  const allow = [{ permission: "*", pattern: "*", action: "allow" }]
  const general = { name: "general", permission: allow }
  const readOnly = {
    name: "explore",
    permission: [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ],
  }
  const base = { agent: "build", config: {}, metadata: undefined, permission: allow }

  test("on while a subagent that can edit may be dispatched", () => {
    expect(workflowsLabel({ ...base, subagents: [general, readOnly] })).toBe(
      "Dynamic workflows: on · main agent orchestrating",
    )
  })

  test("the task tool denied to the agent", () => {
    const permission = [...allow, { permission: "task", pattern: "*", action: "deny" }]
    expect(workflowsLabel({ ...base, permission, subagents: [general] })).toBe("Dynamic workflows: off · task denied")
    expect(workflowsLabel({ ...base, permission, subagents: [general], narrow: true })).toBe(
      "Dynamic workflows: off · task denied",
    )
  })

  test("the task tool denied by the session's own rules", () => {
    const session = [{ permission: "task", pattern: "*", action: "deny" }]
    expect(workflowsLabel({ ...base, session, subagents: [general] })).toBe("Dynamic workflows: off · task denied")
  })

  test("every subagent it may dispatch has edit turned off", () => {
    expect(workflowsLabel({ ...base, subagents: [readOnly] })).toBe("Dynamic workflows: off · no subagent can edit")
    // general can edit but may not be dispatched: only explore is left.
    const permission = [...allow, { permission: "task", pattern: "general", action: "deny" }]
    expect(workflowsLabel({ ...base, permission, subagents: [general, readOnly] })).toBe(
      "Dynamic workflows: off · no subagent can edit",
    )
  })

  test("subagent_depth 0, and an organisation lock keeps its padlock", () => {
    expect(workflowsLabel({ ...base, config: { subagent_depth: 0 }, subagents: [general] })).toBe(
      "Dynamic workflows: off · subagent_depth 0",
    )
    expect(workflowsLabel({ ...base, config: { $locked: ["workflows.dynamic"] }, subagents: [readOnly] })).toBe(
      "Dynamic workflows: off · no subagent can edit 🔒",
    )
  })

  test("turned off by setting: no reason, nothing to fix", () => {
    expect(workflowsLabel({ ...base, metadata: { workflows: { dynamic: false } }, subagents: [readOnly] })).toBe(
      "Dynamic workflows: off",
    )
  })
})
