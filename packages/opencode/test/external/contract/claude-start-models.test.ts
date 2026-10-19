import { expect } from "bun:test"
import { ExternalClaude } from "../../../src/external/claude"
import { contract } from "../record/harness"

// XCOD-270, #243: the models Claude Code lists in its `initialize` response, which `/models` offers,
// and what the no-prompt start that asks for them does.
contract("claude", "start-models", ([start]) => {
  const response = start!.tool.find((m) => m.type === "control_response")?.response
  expect(response?.subtype).toBe("success")
  // The shape parseModels reads: `models: { value, displayName, description }[]`.
  expect(Array.isArray(response.response.models)).toBe(true)
  expect(start!.models!.length).toBe(response.response.models.length)
  for (const model of start!.models!) expect(model.id).toMatch(ExternalClaude.MODEL_ID)
  // No prompt is sent, so no model is called.
  expect(start!.host.some((m) => m.type === "user")).toBe(false)
  // What it writes under the throwaway HOME is in the manifest (step.home); it removes nothing.
  expect(start!.step.home.removed).toEqual([])
})
