import { expect } from "bun:test"
import { contract } from "../record/harness"

// XCOD-270: `/compact` sent on a resumed session is run by Claude Code, not passed to the model.
contract("claude", "compact", ([first, compact]) => {
  expect(first!.result).toMatchObject({ type: "result", ok: true })
  expect(compact!.argv).toContain("--resume")
  expect(compact!.host.find((m) => m.type === "user")?.message.content).toBe("/compact")
  expect(compact!.tool.some((m) => m?.type === "system" && m.subtype === "compact_boundary")).toBe(true)
  expect(compact!.result).toMatchObject({ type: "result", ok: true })
})
