import { expect } from "bun:test"
import { ExternalHooks } from "../../../src/external/hooks"
import { contract } from "../record/harness"

// XCOD-270: one of Claude Code's own tools asks through `can_use_tool`, Lunos allows it, and the
// tool's name is one Lunos hooks know.
contract("claude", "native-approval", ([turn]) => {
  expect(turn!.asked.length).toBeGreaterThan(0)
  for (const request of turn!.asked) {
    expect(ExternalHooks.call("claude", request.tool, request.input).tool).not.toBe(request.tool)
    expect(turn!.events.some((event) => event.type === "tool" && event.id === request.toolUseID)).toBe(true)
  }
  expect(turn!.host.filter((m) => m.type === "control_response").map((m) => m.response.response.behavior)).toEqual(
    turn!.asked.map(() => "allow"),
  )
  expect(turn!.result).toMatchObject({ type: "result", ok: true, denied: [] })
})
