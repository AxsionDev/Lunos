import { expect } from "bun:test"
import { contract, unhandled } from "../record/harness"

// XCOD-270: one of Codex's own changes asks through an `item/…/requestApproval`, Lunos accepts it,
// and the item completes.
contract("codex", "native-approval", ([turn]) => {
  expect(turn!.asked.length).toBeGreaterThan(0)
  for (const request of turn!.asked) expect(["FileChange", "Bash"]).toContain(request.tool)
  expect(unhandled(turn!)).toEqual([])
  const decisions = turn!.host.filter((m) => m.result?.decision).map((m) => m.result.decision)
  expect(decisions).toEqual(turn!.asked.map(() => "accept"))
  const completed = turn!.tool.filter(
    (m) => m?.method === "item/completed" && ["fileChange", "commandExecution"].includes(m.params?.item?.type),
  )
  expect(completed.some((m) => m.params.item.status === "completed")).toBe(true)
  expect(turn!.result).toMatchObject({ type: "result", ok: true, denied: [] })
})
