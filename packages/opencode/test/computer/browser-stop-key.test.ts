import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Computer } from "@/computer"
import { Desktop } from "@/computer/desktop"
import { Control } from "@/control"
import { FakeDesktop } from "./fake"

// XCOD-327: browser control's stop key works from any app, not only while the controlled page has
// focus. While browser control is active, the OS-wide key is polled as for computer control; it
// draws no on-screen indicator (the browser has its own) and the user's mouse doesn't pause it.

let desktop: FakeDesktop

beforeEach(() => {
  desktop = new FakeDesktop()
  Computer.use(desktop)
  Control.reset()
})

afterEach(() => {
  Computer.use(undefined)
})

async function until(check: () => boolean, ms = 1_000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(5)
  return check()
}

describe("the browser's OS-wide stop key", () => {
  test("held in any app, it ends the browser action in flight within 200 ms", async () => {
    expect(await Computer.watchBrowserKey(undefined)).toBe(true)
    const run = Control.begin("browser")
    const pressed = Date.now()
    desktop.pressed = Desktop.parse("ctrl+alt+escape")
    expect(await until(() => run.signal.aborted)).toBe(true)
    expect(Date.now() - pressed).toBeLessThan(200)
    expect(run.signal.reason).toBeInstanceOf(Control.StoppedError)
    expect(Control.held("browser")).toMatchObject({ why: "stopped", origin: "stop key" })
    run.end()
    // Stopped: the watcher is gone until the next browser action.
    expect(await until(() => !Computer.watchingBrowserKey())).toBe(true)
  })

  test("uses browser.stop_key when it's set", async () => {
    await Computer.watchBrowserKey("ctrl+shift+f12")
    desktop.pressed = Desktop.parse("ctrl+alt+escape")
    await Bun.sleep(100)
    expect(Control.held("browser")).toBeUndefined()
    desktop.pressed = Desktop.parse("ctrl+shift+f12")
    expect(await until(() => Control.held("browser") !== undefined)).toBe(true)
  })

  test("draws no on-screen indicator and isn't paused by the user's mouse", async () => {
    await Computer.watchBrowserKey(undefined)
    desktop.mouseAt = Date.now() + 1_000
    await Bun.sleep(100)
    expect(desktop.indicators).toBe(0)
    expect(Control.held("browser")).toBeUndefined()
    expect(Control.held("computer")).toBeUndefined()
  })

  test("a stop from the page (or anywhere else) ends the watcher", async () => {
    await Computer.watchBrowserKey(undefined)
    expect(Computer.watchingBrowserKey()).toBe(true)
    Control.stop("browser", "on-screen Stop")
    expect(Computer.watchingBrowserKey()).toBe(false)
  })
})
