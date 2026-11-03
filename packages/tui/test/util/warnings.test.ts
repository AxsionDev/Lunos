import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { routeWarnings } from "../../src/util/warnings"

test("XCOD-341: while the TUI runs, process warnings go to the run log, not stderr", async () => {
  const before = process.listeners("warning")
  const notes: { title: string; lines: string[] }[] = []
  const restore = routeWarnings((title, lines) => notes.push({ title, lines }))
  try {
    // The runtime's own stderr printer is gone; only ours is left.
    for (const listener of before) expect(process.listeners("warning")).not.toContain(listener)
    const emitter = new EventEmitter()
    for (let i = 0; i < 11; i++) emitter.on("destroyed", () => {})
    await Bun.sleep(20)
  } finally {
    restore()
  }
  expect(notes.some((note) => note.title.includes("MaxListenersExceededWarning"))).toBe(true)
  expect(notes.find((note) => note.title.includes("MaxListeners"))?.lines[0]).toContain("11 destroyed listeners")
  // After the TUI, the original listeners are back.
  expect(process.listeners("warning")).toEqual(before)
})
