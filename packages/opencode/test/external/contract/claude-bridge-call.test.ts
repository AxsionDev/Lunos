import { expect } from "bun:test"
import { contract } from "../record/harness"

// XCOD-270, #247: the `--mcp-config` flag and file format, and how Claude Code names a bridged tool
// in its approval request (the stand-in bridge's one tool, `say`).
contract("claude", "bridge-call", ([turn]) => {
  expect(turn!.argv).toContain("--mcp-config")
  const init = turn!.events.find((event) => event.type === "init")
  expect(init).toMatchObject({ mcp: expect.arrayContaining([{ name: "lunos", status: "connected" }]) })
  expect(turn!.asked.map((request) => request.tool)).toContain("mcp__lunos__say")
  const call = turn!.events.find((event) => event.type === "tool" && event.name === "mcp__lunos__say")
  expect(call).toBeDefined()
  const output = turn!.events.find(
    (event) => event.type === "tool_result" && call?.type === "tool" && event.id === call.id,
  )
  expect(output).toMatchObject({ isError: false, output: expect.stringContaining("said ok") })
  expect(turn!.result).toMatchObject({ type: "result", ok: true })
})
