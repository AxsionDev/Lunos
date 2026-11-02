import { expect } from "bun:test"
import { ExternalHooks } from "../../../src/external/hooks"
import { contract, unhandled } from "../record/harness"

// XCOD-270, #249: a Lunos hook refuses one of Codex's own commands; the hook sees it as Lunos's
// `bash`, Codex is told to decline, and the command doesn't run.
contract("codex", "hook-denied", ([turn]) => {
  const bash = turn!.asked.find((request) => request.tool === "Bash")
  expect(bash).toBeDefined()
  expect(ExternalHooks.call("codex", "Bash", bash!.input).args.command).toContain("touch denied.txt")
  expect(unhandled(turn!)).toEqual([])
  expect(turn!.host.filter((m) => m.result?.decision).map((m) => m.result.decision)).toContain("decline")
  const item = turn!.tool.find((m) => m?.method === "item/completed" && m.params?.item?.id === bash!.toolUseID)
  expect(item?.params.item.status).not.toBe("completed")
  expect(turn!.result).toMatchObject({ type: "result" })
  if (turn!.result?.type === "result") expect(turn!.result.denied.map((entry) => entry.tool)).toContain("Bash")
})
