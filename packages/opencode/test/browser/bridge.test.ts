import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BrowserBridge } from "@/browser/bridge"
import { BrowserDriver } from "@/browser/driver"
import { BrowserLaunch } from "@/browser/launch"
import type { BrowserCdp } from "@/browser/cdp"
import { Control } from "@/control"
import { serve } from "./fixture"

// XCOD-327: "My browser". The local server only takes a browser extension that presents the pairing
// code; a fake extension here relays to a real headless Chrome the way the extension relays through
// chrome.debugger, so the driver runs over the bridge unchanged.

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

describe("BrowserBridge checks", () => {
  test("only an extension origin and the right code are accepted", () => {
    expect(BrowserBridge.originAllowed(ORIGIN)).toBe(true)
    expect(BrowserBridge.originAllowed("https://evil.example")).toBe(false)
    expect(BrowserBridge.originAllowed("null")).toBe(false)
    expect(BrowserBridge.originAllowed(null)).toBe(false)
    expect(BrowserBridge.tokenMatches("a".repeat(64), "a".repeat(64))).toBe(true)
    expect(BrowserBridge.tokenMatches("a".repeat(64), "b".repeat(64))).toBe(false)
    expect(BrowserBridge.tokenMatches("a".repeat(64), null)).toBe(false)
  })

  test("the pairing code is 256 random bits in a file only the user can read", async () => {
    const token = await BrowserBridge.token()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    const mode = (await fs.stat(BrowserBridge.tokenFile())).mode & 0o777
    if (process.platform !== "win32") expect(mode).toBe(0o600)
    expect(await BrowserBridge.token()).toBe(token)
  })
})

const chrome = BrowserLaunch.find()
const suite = chrome ? describe : describe.skip

suite("BrowserBridge with a relaying extension (real Chrome)", () => {
  let site: ReturnType<typeof serve>
  let backend: BrowserCdp.Browser
  let bridge: Awaited<ReturnType<typeof BrowserBridge.serve>>
  let extension: WebSocket
  let profile: string
  const stops: string[] = []

  beforeAll(async () => {
    site = serve()
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-bridge-"))
    backend = await BrowserLaunch.start({ headless: true, profile })
    bridge = await BrowserBridge.serve({ port: 0, onStop: (origin) => stops.push(origin) })
  }, 30_000)

  afterAll(async () => {
    extension?.close()
    bridge?.stop()
    backend?.dispose()
    site?.stop(true)
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  })

  const url = (token: string) => `ws://127.0.0.1:${bridge.port}/?token=${token}`

  test("a web page's origin and a wrong code are refused", async () => {
    const token = await BrowserBridge.token()
    const page = await fetch(url(token).replace("ws:", "http:"), {
      headers: { origin: "https://evil.example", upgrade: "websocket" },
    })
    expect(page.status).toBe(403)
    const wrong = await fetch(url("0".repeat(64)).replace("ws:", "http:"), {
      headers: { origin: ORIGIN, upgrade: "websocket" },
    })
    expect(wrong.status).toBe(401)
  })

  test("the driver reads and acts in the user's tab through the extension, and Stop reaches Lunos", async () => {
    const token = await BrowserBridge.token()
    const tab = await backend.page()
    extension = new WebSocket(url(token), { headers: { origin: ORIGIN } } as never)
    extension.onmessage = async (event) => {
      const message = JSON.parse(String(event.data))
      const reply = (result: unknown) => extension.send(JSON.stringify({ id: message.id, result }))
      if (message.type === "tabs") return reply([{ id: tab.id, url: "", title: "", active: true }])
      if (message.type === "downloads") return reply({})
      if (message.type === "cdp")
        return tab
          .send(message.method, message.params)
          .then(reply)
          .catch((error) => extension.send(JSON.stringify({ id: message.id, error: String(error.message) })))
    }
    tab.on((method, params) => extension.send(JSON.stringify({ type: "event", tabId: tab.id, method, params })))
    await bridge.ready(5_000)
    expect(bridge.connected()).toBe(true)

    const driver = new BrowserDriver.Driver(bridge.browser, {
      stopKey: Control.parseKey(undefined),
      downloadsDir: profile,
      onMessage: () => {},
    })
    await driver.navigate(site.url.href)
    const lines = await driver.snapshot()
    expect(BrowserDriver.render(lines)).toContain('heading "Account settings"')
    const name = lines.find((line) => line.name === "Display name" && line.ref)!.ref!
    await driver.act(() => driver.type(name, "via extension", true))
    expect(BrowserDriver.render(await driver.snapshot())).toContain('value="via extension"')

    extension.send(JSON.stringify({ type: "stop", origin: "extension" }))
    await Bun.sleep(100)
    expect(stops).toEqual(["extension"])
  }, 30_000)
})
