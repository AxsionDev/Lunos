import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigBrowser } from "@opencode-ai/core/config/browser"
import { Agent } from "@/agent/agent"
import { Browser } from "@/browser"
import { BrowserBridge } from "@/browser/bridge"
import { BrowserCdp } from "@/browser/cdp"
import { BrowserDriver } from "@/browser/driver"
import { Config } from "@/config/config"
import { Control } from "@/control"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { BrowserTool } from "@/tool/browser"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { serve } from "./fixture"

// XCOD-327: "My browser" with the real extension. The unpacked extension in browser-extension/ is
// loaded into a real Chromium, paired through its own popup, and drives a real tab through
// chrome.debugger. Opt in with LUNOS_REAL_CHROME=1. Branded Chrome ignores --load-extension, so this
// needs Chrome for Testing or Chromium: LUNOS_CHROME_FOR_TESTING=<path to its binary>, or the one
// `bunx playwright install chromium` puts in the Playwright cache. LUNOS_REAL_CHROME_HEADED=1 shows
// the window.

const EXTENSION = path.resolve(import.meta.dir, "../../../../browser-extension")

function chromeForTesting() {
  if (process.env["LUNOS_CHROME_FOR_TESTING"]) return process.env["LUNOS_CHROME_FOR_TESTING"]
  const cache =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Caches/ms-playwright")
      : path.join(os.homedir(), ".cache/ms-playwright")
  const builds = (() => {
    try {
      return readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    } catch {
      return []
    }
  })()
  for (const build of builds) {
    const candidates = [
      path.join(
        cache,
        build,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
      path.join(cache, build, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
      path.join(cache, build, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
      path.join(cache, build, "chrome-linux64/chrome"),
      path.join(cache, build, "chrome-linux/chrome"),
      path.join(cache, build, "chrome-win64/chrome.exe"),
      path.join(cache, build, "chrome-win/chrome.exe"),
    ]
    const found = candidates.find((item) => existsSync(item))
    if (found) return found
  }
  return undefined
}

const executable = process.env["LUNOS_REAL_CHROME"] === "1" ? chromeForTesting() : undefined
const suite = executable ? describe : describe.skip

type Target = { targetId: string; type: string; url: string; title: string }

/** A Chromium with the extension loaded, and a DevTools connection the test drives it with. */
async function launch(profile: string) {
  const child = Bun.spawn(
    [
      executable!,
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(process.env["LUNOS_REAL_CHROME_HEADED"] === "1" ? [] : ["--headless=new"]),
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  )
  const portFile = path.join(profile, "DevToolsActivePort")
  const deadline = Date.now() + 20_000
  let endpoint = ""
  while (!endpoint && Date.now() < deadline) {
    const [port, socket] = (
      await Bun.file(portFile)
        .text()
        .catch(() => "")
    ).split("\n")
    if (port && socket) endpoint = `ws://127.0.0.1:${port.trim()}${socket.trim()}`
    else await Bun.sleep(100)
  }
  if (!endpoint) throw new Error("Chromium didn't start")
  const connection = await BrowserCdp.Connection.open(endpoint)
  const targets = async () => (await connection.send<{ targetInfos: Target[] }>("Target.getTargets")).targetInfos
  let id: string | undefined
  /** The extension's service worker, if it's running. Chromium has its own extensions too. */
  const worker = async (ms = 15_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const workers = (await targets()).filter(
        (target) => target.type === "service_worker" && target.url.endsWith("/background.js"),
      )
      if (id) {
        const found = workers.find((target) => new URL(target.url).host === id)
        if (found) return found
      } else
        for (const target of workers) {
          // Detached again at once: an attached debugger would keep the worker from stopping.
          const session = await attach(target.targetId).catch(() => undefined)
          const name = await session?.evaluate<string>("chrome.runtime.getManifest().name").catch(() => "")
          await session?.detach()
          if (name !== "Lunos") continue
          id = new URL(target.url).host
          return target
        }
      await Bun.sleep(100)
    }
    return undefined
  }
  const attach = async (targetId: string) => {
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    })
    return {
      detach: () => connection.send("Target.detachFromTarget", { sessionId }).catch(() => {}),
      send: <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) =>
        connection.send<T>(method, params, sessionId),
      evaluate: async <T>(expression: string) =>
        (
          await connection.send<{ result: { value: T }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            sessionId,
          )
        ).result?.value,
    }
  }
  return {
    connection,
    targets,
    worker,
    attach,
    close() {
      connection.close()
      if (child.exitCode === null) child.kill()
    },
  }
}

const until = async (check: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await Bun.sleep(100)
  }
  return false
}

let settings: ConfigBrowser.Info = {}
const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, Truncate.node, Agent.node, Permission.node, EventV2Bridge.node]), [
    [Config.node, TestConfig.layer({ get: () => Effect.sync(() => ({ browser: settings }) as never) })],
  ]),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_real_extension"),
  messageID: MessageID.make("msg_real_extension"),
  callID: "call_real_extension",
  agent: "qa",
  abort: new AbortController().signal,
  messages: [],
  extra: { model: { providerID: "mistral", api: {}, capabilities: { input: { image: false } } } },
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const exec = (params: Tool.InferParameters<typeof BrowserTool>) =>
  Effect.gen(function* () {
    const info = yield* BrowserTool
    const tool = yield* info.init()
    return yield* tool.execute(params, ctx)
  })

/** The code exactly as `lunos browser pair` prints it, run from source with the test's data dir. */
async function pairingCode() {
  const cli = Bun.spawn(
    [process.execPath, "run", path.resolve(import.meta.dir, "../../src/index.ts"), "browser", "pair"],
    {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = await new Response(cli.stdout).text()
  expect(await cli.exited).toBe(0)
  return output.match(/^\s+([a-f0-9]{64})$/m)![1]!
}

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  probe.stop(true)
  return port
}

suite("the real Lunos extension in Chromium", () => {
  let site: ReturnType<typeof serve>
  let away: ReturnType<typeof Bun.serve>
  let chromium: Awaited<ReturnType<typeof launch>>
  let bridge: Awaited<ReturnType<typeof BrowserBridge.serve>>
  let profile: string
  let extensionId: string
  let code: string
  const stops: string[] = []
  const messages: BrowserDriver.Message[] = []

  beforeAll(async () => {
    site = serve()
    // A site on the allow list that redirects to one on the deny list.
    away = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(`http://localhost:${site.port}/`, 302),
    })
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-real-ext-"))
    chromium = await launch(profile)
    bridge = await BrowserBridge.serve({ port: 0, onStop: (origin) => stops.push(origin) })
  }, 40_000)

  afterAll(async () => {
    await Browser.close()
    bridge?.stop()
    chromium?.close()
    site?.stop(true)
    away?.stop(true)
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  })

  /** Pairs the way a user does: the code and port typed into the popup, then Connect. */
  const pair = async (token: string, port: number) => {
    const { targetId } = await chromium.connection.send<{ targetId: string }>("Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup.html`,
    })
    const popup = await chromium.attach(targetId)
    const ready = `!!document.getElementById("connect") && document.readyState === "complete"`
    await until(
      () =>
        popup.evaluate<boolean>(ready).then(
          (value) => value === true,
          () => false,
        ),
      10_000,
    )
    await popup.evaluate(`(() => {
      document.getElementById("token").value = ${JSON.stringify(token)}
      document.getElementById("port").value = ${JSON.stringify(String(port))}
      document.getElementById("connect").click()
    })()`)
    await Bun.sleep(1_000)
    const status = await popup.evaluate<string>(`document.getElementById("status").textContent`)
    await chromium.connection.send("Target.closeTarget", { targetId })
    return status
  }

  const tab = async (url: string) => {
    const found = (await chromium.targets()).find((target) => target.type === "page" && target.url === url)
    return chromium.attach(found!.targetId)
  }

  test("the extension loads, and its service worker runs", async () => {
    const worker = await chromium.worker()
    expect(worker).toBeDefined()
    extensionId = new URL(worker!.url).host
    expect(extensionId).toMatch(/^[a-p]{32}$/)
  })

  test("a wrong pairing code is refused; the one `lunos browser pair` prints connects", async () => {
    const status = await pair("0".repeat(64), bridge.port!)
    expect(bridge.connected()).toBe(false)
    expect(status).not.toBe("connected")
    code = await pairingCode()
    expect(code).toBe(await BrowserBridge.token())
    expect(await pair(code, bridge.port!)).toBe("connected")
    expect(await until(() => bridge.connected(), 5_000)).toBe(true)
  }, 30_000)

  test("a web page can't connect, even with the code", async () => {
    const { targetId } = await chromium.connection.send<{ targetId: string }>("Target.createTarget", {
      url: site.url.href,
    })
    const page = await chromium.attach(targetId)
    const result = await page.evaluate<string>(`new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:${bridge.port}/?token=${code}")
      ws.onopen = () => resolve("open")
      ws.onerror = () => resolve("refused")
    })`)
    await chromium.connection.send("Target.closeTarget", { targetId })
    expect(result).toBe("refused")
    expect(bridge.connected()).toBe(true)
  }, 20_000)

  let driver: BrowserDriver.Driver
  test("Lunos reads, clicks and types in a real tab through chrome.debugger", async () => {
    driver = new BrowserDriver.Driver(bridge.browser, {
      stopKey: Control.parseKey(undefined),
      downloadsDir: profile,
      onMessage: (message) => messages.push(message),
    })
    await driver.navigate(site.url.href)
    expect(await driver.url()).toBe(site.url.href)
    const lines = await driver.snapshot()
    expect(BrowserDriver.render(lines)).toContain('heading "Account settings"')
    const name = lines.find((line) => line.name === "Display name" && line.ref)!.ref!
    await driver.act(() => driver.type(name, "typed via the real extension", true))
    expect(BrowserDriver.render(await driver.snapshot())).toContain('value="typed via the real extension"')
    const page = await tab(site.url.href)
    expect(await page.evaluate<string>("document.getElementById('display').value")).toBe("typed via the real extension")
    await page.detach()
    const next = (await driver.snapshot()).find((line) => line.name === "Next page" && line.ref)!.ref!
    await driver.act(() => driver.click(next))
    await driver.settle()
    expect(await driver.url()).toBe(new URL("/next", site.url).href)
    expect(BrowserDriver.render(await driver.snapshot())).toContain('heading "Second page"')
  }, 40_000)

  test("the indicator and the stop key run in the isolated world, and the key reaches Lunos", async () => {
    await driver.navigate(site.url.href)
    const page = await tab(site.url.href)
    // The page's own scripts can't see the binding; the indicator is there, its shadow root closed.
    expect(await page.evaluate<string>("typeof window.__lunosControl")).toBe("undefined")
    expect(await page.evaluate<string>("typeof window.__lunosOverlay")).toBe("undefined")
    expect(await page.evaluate<boolean>("!!document.getElementById('__lunos_indicator')")).toBe(true)
    expect(await page.evaluate<boolean>("document.getElementById('__lunos_indicator').shadowRoot === null")).toBe(true)
    messages.length = 0
    const started = Date.now()
    const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 1 | 2 }
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key })
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key })
    expect(await until(() => messages.some((item) => item.kind === "stop"), 2_000)).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
    expect(messages.find((item) => item.kind === "stop")!.origin).toBe("stop key")
    await page.detach()
  }, 30_000)

  test("after Chrome stops the service worker, the extension reconnects and control resumes", async () => {
    const page = await tab(site.url.href)
    await page.send("ServiceWorker.enable")
    await page.send("ServiceWorker.stopAllWorkers")
    await page.detach()
    // stopAllWorkers covers the page's own origin only: stop the extension's worker directly too.
    const worker = await chromium.worker(1_000)
    if (worker) await chromium.connection.send("Target.closeTarget", { targetId: worker.targetId }).catch(() => {})
    expect(await until(() => !bridge.connected(), 10_000)).toBe(true)
    expect(await until(() => bridge.connected(), 75_000)).toBe(true)
    // Lunos starts a new driver once the old connection closes (Browser.get), as here. The restarted
    // worker finds its own earlier debugger still on the tab, and the controls must come back on the
    // page that's already open, without a navigation.
    driver = new BrowserDriver.Driver(bridge.browser, {
      stopKey: Control.parseKey(undefined),
      downloadsDir: profile,
      onMessage: (message) => messages.push(message),
    })
    expect(BrowserDriver.render(await driver.snapshot())).toContain('heading "Account settings"')
    const tabPage = await tab(site.url.href)
    messages.length = 0
    const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 1 | 2 }
    await tabPage.send("Input.dispatchKeyEvent", { type: "keyDown", ...key })
    await tabPage.send("Input.dispatchKeyEvent", { type: "keyUp", ...key })
    expect(await until(() => messages.some((item) => item.origin === "stop key"), 2_000)).toBe(true)
    // The indicator's Stop button, clicked like a user would (its shadow root is closed).
    const rect = await tabPage.evaluate<{ x: number; y: number }>(`(() => {
      const box = document.getElementById("__lunos_indicator").getBoundingClientRect()
      return { x: box.right - 20, y: box.top + box.height / 2 }
    })()`)
    messages.length = 0
    for (const type of ["mousePressed", "mouseReleased"])
      await tabPage.send("Input.dispatchMouseEvent", { type, ...rect, button: "left", clickCount: 1 })
    expect(await until(() => messages.some((item) => item.origin === "indicator"), 2_000)).toBe(true)
    await tabPage.detach()
    await driver.navigate(new URL("/next", site.url).href)
    expect(BrowserDriver.render(await driver.snapshot())).toContain('heading "Second page"')
  }, 100_000)

  // The browser tool itself, in "extension" mode, on the extension's own server.
  it.instance(
    "the browser tool acts through the extension, and refuses deny-listed and banking sites in the real tab",
    () =>
      Effect.gen(function* () {
        bridge.stop()
        const port = freePort()
        settings = { enabled: true, mode: "extension", port, allow: ["127.0.0.1"], deny: ["localhost"] }
        Control.reset()
        yield* Effect.promise(() => pair("", port))
        const opened = yield* exec({ action: "navigate", url: site.url.href })
        expect(opened.output).toContain("Account settings")
        const read = yield* exec({ action: "read" })
        const display = read.output.match(/textbox "Display name" \[ref=(e\d+)\]/)![1]!
        const typed = yield* exec({ action: "type", ref: display, text: "from the tool" })
        expect(typed.output).not.toContain("Refused")
        expect((yield* exec({ action: "read" })).output).toContain('value="from the tool"')

        const denied = yield* exec({ action: "navigate", url: `http://localhost:${site.port}/` })
        expect(denied.output).toContain("deny list")
        const bank = yield* exec({ action: "navigate", url: "https://www.chase.com/" })
        expect(bank.output).toContain("banking site")
        const redirected = yield* exec({ action: "navigate", url: away.url.href })
        expect(redirected.output).toContain("The tab was cleared")
        const now = (yield* Effect.promise(() => chromium.targets())).filter((target) => target.type === "page")
        expect(now.some((target) => target.url.startsWith(`http://localhost:${site.port}`))).toBe(false)
      }),
    { timeout: 60_000 },
  )
})
