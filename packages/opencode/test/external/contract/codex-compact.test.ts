import { expect } from "bun:test"
import { contract, unhandled } from "../record/harness"

// XCOD-270: `/compact` on a resumed Codex session goes to `thread/compact/start` and compacts it.
contract("codex", "compact", ([first, compact]) => {
  expect(first!.result).toMatchObject({ type: "result", ok: true })
  const start = compact!.host.find((m) => m.method === "thread/compact/start")
  expect(start).toBeDefined()
  expect(compact!.tool.find((m) => m?.id === start.id && !m.method)?.error).toBeUndefined()
  expect(
    compact!.tool.some((m) => m?.method === "item/completed" && m.params?.item?.type === "contextCompaction"),
  ).toBe(true)
  expect(unhandled(compact!)).toEqual([])
  expect(compact!.result).toMatchObject({ type: "result", ok: true })
})
