import { expect } from "bun:test"
import { ExternalHooks } from "../../../src/external/hooks"
import { contract } from "../record/harness"
import { HOOK_MESSAGE } from "../record/scenarios"

// XCOD-270, #249: a Lunos hook refuses one of Claude Code's own calls; the hook sees it as Lunos's
// `bash`, and the refusal reaches the model as the tool's error.
contract("claude", "hook-denied", ([turn]) => {
  const bash = turn!.asked.find((request) => request.tool === "Bash")
  expect(bash).toBeDefined()
  expect(ExternalHooks.call("claude", "Bash", bash!.input)).toMatchObject({
    tool: "bash",
    args: { command: expect.stringContaining("touch denied.txt") },
  })
  const output = turn!.events.find((event) => event.type === "tool_result" && event.id === bash!.toolUseID)
  expect(output).toMatchObject({ isError: true, output: expect.stringContaining(HOOK_MESSAGE) })
  expect(turn!.result).toMatchObject({ type: "result" })
  if (turn!.result?.type === "result") expect(turn!.result.denied.map((item) => item.tool)).toContain("Bash")
})
