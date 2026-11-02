import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BrowserLaunch } from "@/browser/launch"
import { BrowserDriver } from "@/browser/driver"
import { Control } from "@/control"
import { serve } from "./fixture"

// XCOD-327: the driver against a real, headless Chrome. Skipped where none is installed.
const chrome = BrowserLaunch.find()
const suite = chrome ? describe : describe.skip

suite("browser driver (real Chrome)", () => {
  let server: ReturnType<typeof serve>
  let driver: BrowserDriver.Driver
  let profile: string
  const messages: BrowserDriver.Message[] = []

  beforeAll(async () => {
    server = serve()
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-browser-"))
    const browser = await BrowserLaunch.start({ headless: true, profile })
    driver = new BrowserDriver.Driver(browser, {
      stopKey: Control.parseKey(undefined),
      downloadsDir: path.join(profile, "downloads"),
      onMessage: (message) => messages.push(message),
    })
  }, 30_000)

  afterAll(async () => {
    driver?.dispose()
    server?.stop(true)
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  })

  test("reads the page as an accessibility outline with refs", async () => {
    await driver.navigate(server.url.href)
    expect(await driver.title()).toBe("Lunos browser test")
    const lines = await driver.snapshot()
    const text = BrowserDriver.render(lines)
    expect(text).toContain('heading "Account settings"')
    expect(text).toMatch(/textbox "Display name" \[ref=e\d+\]/)
    expect(text).toMatch(/button "Save profile" \[ref=e\d+\]/)
    expect(text).not.toContain("Lunos is controlling")
  }, 30_000)

  test("describes elements for the safety checks", async () => {
    const lines = await driver.snapshot()
    const ref = (name: string) => lines.find((line) => line.name === name && line.ref)!.ref!
    const password = await driver.describe(ref("Password"))
    expect(password.type).toBe("password")
    expect(Control.never(password)).toContain("password")
    const save = await driver.describe(ref("Save profile"))
    expect(save.inForm).toBe(true)
    expect(Control.confirm(save, "click")).toContain("Submit the form")
    const download = await driver.describe(ref("Download report"))
    expect(download.download).toBe(true)
    expect(Control.confirm(download, "click")).toContain("Download")
    const robot = await driver.describe(ref("I'm not a robot"))
    expect(robot.captcha).toBe(true)
    expect(await driver.captcha()).toBe(true)
  }, 30_000)

  test("types, selects and clicks", async () => {
    const lines = await driver.snapshot()
    const ref = (name: string) => lines.find((line) => line.name === name && line.ref)!.ref!
    await driver.act(() => driver.type(ref("Display name"), "Petar", true))
    await driver.act(() => driver.select(ref("Country"), "Germany"))
    const after = BrowserDriver.render(await driver.snapshot())
    expect(after).toContain('value="Petar"')
    await driver.act(() => driver.click(ref("Next page")))
    await driver.settle()
    expect(await driver.url()).toBe(new URL("/next", server.url).href)
  }, 30_000)

  test("the stop key in the page ends control within 200 ms", async () => {
    await driver.navigate(server.url.href)
    await Bun.sleep(300)
    messages.length = 0
    const page = await driver.current()
    const started = performance.now()
    const base = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 1 | 2 }
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base })
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
    while (!messages.length && performance.now() - started < 1000) await Bun.sleep(5)
    expect(messages[0]).toEqual({ kind: "stop", origin: "stop key" })
    expect(performance.now() - started).toBeLessThan(200)
  }, 30_000)

  test("takes a screenshot", async () => {
    const data = await driver.screenshot()
    expect(data.startsWith("data:image/jpeg;base64,")).toBe(true)
    expect(data.length).toBeGreaterThan(1000)
  }, 30_000)

  test("collects console output", async () => {
    expect(driver.console.some((item) => item.text.includes("fixture loaded"))).toBe(true)
    expect(driver.network.some((item) => item.text.includes("200 GET"))).toBe(true)
  })
})
