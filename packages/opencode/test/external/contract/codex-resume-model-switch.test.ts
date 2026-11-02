import { expect } from "bun:test"
import { contract, unhandled } from "../record/harness"

// XCOD-270, #243: whether a changed model applies on Codex's `thread/resume`.
contract("codex", "resume-model-switch", ([first, second]) => {
  for (const step of [first!, second!]) {
    expect(step.result).toMatchObject({ type: "result", ok: true })
    expect(unhandled(step)).toEqual([])
  }
  const resumed = second!.host.find((m) => m.method === "thread/resume")
  expect(resumed.params.model).toBe(second!.step.model!)
  const response = second!.tool.find((m) => m?.id === resumed.id && !m.method)
  expect(response.error).toBeUndefined()
  // The thread reports the model it now runs: the one asked for, not the one it started with.
  expect(response.result.model).toBe(second!.step.model!)
  expect(second!.events.find((event) => event.type === "init")).toMatchObject({ model: second!.step.model })
})
