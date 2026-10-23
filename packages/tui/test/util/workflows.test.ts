// XCOD-303: the footer's Dynamic workflows indicator follows the server's order.
import { describe, expect, test } from "bun:test"
import { workflowsLabel } from "../../src/util/workflows"

describe("workflowsLabel", () => {
  test("on by default, for Build and Dev-Cycle only", () => {
    expect(workflowsLabel({ agent: "build", config: {}, metadata: undefined })).toBe("Dynamic workflows: on")
    expect(workflowsLabel({ agent: "dev-cycle", config: {}, metadata: undefined })).toBe("Dynamic workflows: on")
    expect(workflowsLabel({ agent: "plan", config: {}, metadata: undefined })).toBeUndefined()
    expect(workflowsLabel({ agent: "build", config: {}, metadata: undefined, child: true })).toBeUndefined()
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
    ).toBe("Dynamic workflows: on 🔒")
  })
})
