import { expect } from "bun:test"
import { contract, unhandled } from "../record/harness"

// XCOD-270, #247: the `mcp_servers` override on `thread/start` and Codex's MCP tool-call item; #249:
// whether Codex asks to approve the MCP call, and if so in one of the two shapes Lunos handles.
contract("codex", "bridge-call", ([turn]) => {
  const start = turn!.host.find((m) => m.method === "thread/start")
  expect(start.params.config["mcp_servers.lunos"]).toBeDefined()
  expect(turn!.tool.find((m) => m?.id === start.id && !m.method)?.error).toBeUndefined()
  const item = turn!.tool.find((m) => m?.method === "item/completed" && m.params?.item?.type === "mcpToolCall")?.params
    .item
  expect(item).toMatchObject({ server: "lunos", tool: "say", status: "completed" })
  const output = turn!.events.find((event) => event.type === "tool_result" && event.id === item.id)
  expect(output).toMatchObject({ isError: false, output: expect.stringContaining("said ok") })
  // An approval request in a shape Lunos doesn't read would be refused here, declining the call.
  expect(unhandled(turn!)).toEqual([])
  for (const request of turn!.asked) expect(request.tool).toBe("mcp__lunos__say")
  expect(turn!.result).toMatchObject({ type: "result", ok: true })
})
