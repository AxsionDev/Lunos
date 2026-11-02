export * as BrowserBridge from "./bridge"

import { randomBytes, timingSafeEqual } from "crypto"
import fs from "fs/promises"
import path from "path"
import type { ServerWebSocket } from "bun"
import { Global } from "@opencode-ai/core/global"
import { ConfigBrowser } from "@opencode-ai/core/config/browser"
import { BrowserCdp } from "./cdp"

// XCOD-327: "My browser". The Lunos extension in the user's own Chrome, Edge or Brave connects to
// this WebSocket server, which listens on 127.0.0.1 only and is never exposed to the network. A
// connection is accepted only when:
// - its Origin is a browser extension's (any web page can open ws://127.0.0.1, but not with that
//   Origin), and
// - it presents the pairing token, compared in constant time. The token is a random 256-bit value
//   in a file only the user can read (0600); `lunos browser pair` prints it for the extension.
// One extension at a time; a second connection is refused while one is open.

export function tokenFile() {
  return path.join(Global.Path.data, "browser", "extension-token")
}

/** The pairing token, created on first use. */
export async function token() {
  const file = tokenFile()
  const existing = await Bun.file(file)
    .text()
    .then((text) => text.trim())
    .catch(() => "")
  if (/^[a-f0-9]{64}$/.test(existing)) return existing
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const created = randomBytes(32).toString("hex")
  await fs.writeFile(file, created + "\n", { mode: 0o600 })
  await fs.chmod(file, 0o600)
  return created
}

export function originAllowed(origin: string | null) {
  return !!origin && /^(chrome|moz|edge)-extension:\/\/[a-z0-9-]+\/?$/i.test(origin)
}

export function tokenMatches(expected: string, given: string | null) {
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

type Message = {
  id?: number
  result?: unknown
  error?: string
  type?: string
  tabId?: string
  method?: string
  params?: Record<string, unknown>
  origin?: string
}

export class NotConnectedError extends Error {
  constructor(port: number) {
    super(
      `The Lunos extension isn't connected. Install it in Chrome, Edge or Brave (chrome://extensions › Load unpacked › the browser-extension folder of the Lunos source), run \`lunos browser pair\` and paste the code into the extension, then try again. It connects to 127.0.0.1:${port}.`,
    )
    this.name = "BrowserExtensionNotConnectedError"
  }
}

type Socket = ServerWebSocket<undefined>

/**
 * Starts the local server. `onStop` runs when the user presses Stop in the extension or Chrome's
 * "cancel" on its debugging bar.
 */
export async function serve(input: { port?: number; onStop: (origin: string) => void }) {
  const port = input.port ?? ConfigBrowser.DEFAULT_PORT
  const secret = await token()
  let socket: Socket | undefined
  let next = 1
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>()
  const listeners = new Set<(tabId: string, method: string, params: Record<string, unknown>) => void>()
  const closeListeners = new Set<() => void>()

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, srv) {
      const url = new URL(request.url)
      if (!originAllowed(request.headers.get("origin"))) return new Response("Forbidden", { status: 403 })
      if (!tokenMatches(secret, url.searchParams.get("token"))) return new Response("Unauthorized", { status: 401 })
      if (socket) return new Response("Another browser is already connected", { status: 409 })
      if (srv.upgrade(request)) return undefined
      return new Response("Upgrade required", { status: 426 })
    },
    websocket: {
      open(ws) {
        socket = ws
      },
      message(_ws, raw) {
        const message = JSON.parse(String(raw)) as Message
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
          const waiting = pending.get(message.id)
          if (!waiting) return
          pending.delete(message.id)
          if (message.error) waiting.reject(new BrowserCdp.CdpError(waiting.method, message.error))
          else waiting.resolve(message.result ?? {})
          return
        }
        if (message.type === "event" && message.method)
          for (const listener of listeners) listener(message.tabId ?? "", message.method, message.params ?? {})
        if (message.type === "stop") input.onStop("extension")
      },
      close(ws) {
        if (socket !== ws) return
        socket = undefined
        for (const waiting of pending.values())
          waiting.reject(new BrowserCdp.CdpError(waiting.method, "the extension disconnected"))
        pending.clear()
        for (const listener of closeListeners) listener()
      },
    },
  })

  const call = <T>(type: string, body: Record<string, unknown> = {}) => {
    if (!socket) return Promise.reject(new NotConnectedError(port))
    const id = next++
    const method = String(body.method ?? type)
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      socket!.send(JSON.stringify({ id, type, ...body }))
    })
  }

  const page = (tabId: string): BrowserCdp.Page => ({
    id: tabId,
    send: (method, params) => call("cdp", { tabId, method, params: params ?? {} }),
    on: (listener) => {
      const wrapped = (from: string, method: string, params: Record<string, unknown>) => {
        if (from === tabId) listener(method, params)
      }
      listeners.add(wrapped)
      return () => listeners.delete(wrapped)
    },
  })

  const browser: BrowserCdp.Browser = {
    mode: "extension",
    tabs: () => call<BrowserCdp.Tab[]>("tabs"),
    async page() {
      const tabs = await call<BrowserCdp.Tab[]>("tabs")
      const active = tabs.find((tab) => tab.active) ?? tabs[0]
      if (!active) return this.open("about:blank")
      return page(active.id)
    },
    async open(url) {
      const tab = await call<BrowserCdp.Tab>("open", { url })
      return page(tab.id)
    },
    async activate(id) {
      await call("activate", { tabId: id })
      return page(id)
    },
    async close(id) {
      await call("close", { tabId: id })
    },
    async downloads(allow) {
      await call("downloads", { allow })
    },
    onEvent(listener) {
      const wrapped = (from: string, method: string, params: Record<string, unknown>) => {
        if (!from) listener(method, params)
      }
      listeners.add(wrapped)
      return () => listeners.delete(wrapped)
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    dispose() {
      socket?.close()
      server.stop(true)
    },
  }

  return {
    browser,
    port: server.port,
    connected: () => !!socket,
    /** Waits up to `ms` for the extension to connect. */
    async ready(ms: number) {
      const deadline = Date.now() + ms
      while (!socket && Date.now() < deadline) await Bun.sleep(100)
      if (!socket) throw new NotConnectedError(server.port ?? port)
    },
  }
}
