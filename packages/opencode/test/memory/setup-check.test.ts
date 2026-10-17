import { expect, test } from "bun:test"
import { MemorySetupCheck } from "../../src/memory/setup-check"
import { checkFix } from "../../src/cli/cmd/memory-setup"

test("XCOD-249: the check runs lunos, not the TUI worker the server lives in", () => {
  expect(MemorySetupCheck.entry(["/bun", "/r/src/cli/tui/worker.ts"])).toEqual(["/bun", "/r/src/index.ts"])
  expect(MemorySetupCheck.entry(["/bun", "/r/src/index.ts", "x"])).toEqual(["/bun", "/r/src/index.ts", "x"])
  expect(MemorySetupCheck.entry(["/lunos", "/$bunfs/root/lunos"])).toEqual(["/lunos", "/$bunfs/root/lunos"])
})

test("XCOD-249: a failing check says what to do for the errors a first start hits", () => {
  expect(checkFix("Memory needs uv (https://docs.astral.sh/uv/) and Python 3.10–3.13")).toContain("Install uv")
  expect(checkFix("No model is configured, and memory needs one to run")).toContain("/providers")
  expect(checkFix("Blocked by data-residency policy. memory.backend declares jurisdiction")).toContain("region")
  expect(checkFix("something else")).toBeUndefined()
})
