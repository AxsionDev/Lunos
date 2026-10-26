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
      "Dynamic workflows: off",
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
