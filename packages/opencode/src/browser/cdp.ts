export * as BrowserCdp from "./cdp"

// XCOD-327: the Chrome DevTools Protocol, the one interface both modes drive. The Lunos browser
// speaks it over the browser's own WebSocket on 127.0.0.1; the extension relays it through
// chrome.debugger. Everything above this file only sees `Page` and `Browser`.

export type Listener = (method: string, params: Record<string, unknown>) => void

/** One tab: commands go to it, its events come back. */
export interface Page {
  readonly id: string
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  on(listener: Listener): () => void
}

export type Tab = { id: string; url: string; title: string; active: boolean }

/** A browser: its tabs, the one being controlled, and how to end the connection. */
export interface Browser {
  readonly mode: "lunos" | "extension"
  tabs(): Promise<Tab[]>
  page(): Promise<Page>
  open(url: string): Promise<Page>
  activate(id: string): Promise<Page>
  close(id: string): Promise<void>
  /** Allow the next download (true), or refuse downloads again (false). */
  downloads(allow: boolean, dir: string): Promise<void>
  /** Browser-level events (downloads), not tied to a tab. */
  onEvent(listener: Listener): () => void
  onClose(listener: () => void): () => void
  dispose(): void
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`)
    this.name = "CdpError"
  }
}

/**
 * A CDP connection over WebSocket, with flat sessions: a command sent with a `sessionId` goes to
 * that target, and events carry the session they came from.
 */
export class Connection {
  private next = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>()
  private listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>()
  private closeListeners = new Set<() => void>()
  closed = false

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
        method?: string
        params?: Record<string, unknown>
        sessionId?: string
      }
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id)
        if (!waiting) return
        this.pending.delete(message.id)
        if (message.error) waiting.reject(new CdpError(waiting.method, message.error.message))
        else waiting.resolve(message.result ?? {})
        return
      }
      if (message.method)
        for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId)
    })
    socket.addEventListener("close", () => this.shutdown())
    socket.addEventListener("error", () => this.shutdown())
  }

  static open(url: string, timeoutMs = 10_000) {
    return new Promise<Connection>((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`Couldn't connect to the browser at ${url}`))
      }, timeoutMs)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new Connection(socket))
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error(`Couldn't connect to the browser at ${url}`))
      })
    })
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed) return Promise.reject(new CdpError(method, "the browser connection is closed"))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onClose(listener: () => void) {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close() {
    this.socket.close()
    this.shutdown()
  }

  private shutdown() {
    if (this.closed) return
    this.closed = true
    for (const waiting of this.pending.values()) waiting.reject(new CdpError(waiting.method, "the browser closed"))
    this.pending.clear()
    for (const listener of this.closeListeners) listener()
  }
}

/** The Lunos browser: a Chrome Lunos started, driven through its DevTools WebSocket. */
export function direct(connection: Connection, onDispose: () => void): Browser {
  const sessions = new Map<string, string>()
  let current: string | undefined

  const attach = async (targetId: string): Promise<Page> => {
    const known = sessions.get(targetId)
    const sessionId =
      known ??
      (await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId
    sessions.set(targetId, sessionId)
    current = targetId
    return {
      id: targetId,
      send: (method, params) => connection.send(method, params, sessionId),
      on: (listener) =>
        connection.on((method, params, from) => {
          if (from === sessionId) listener(method, params)
        }),
    }
  }

  const pages = async () =>
    (
      await connection.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>(
        "Target.getTargets",
      )
    ).targetInfos.filter((target) => target.type === "page")

  connection.on((method, params) => {
    if (method !== "Target.targetDestroyed" && method !== "Target.detachedFromTarget") return
    const id = String(params.targetId ?? "")
    sessions.delete(id)
    if (current === id) current = undefined
  })
  void connection.send("Target.setDiscoverTargets", { discover: true }).catch(() => {})

  return {
    mode: "lunos",
    async tabs() {
      return (await pages()).map((target) => ({
        id: target.targetId,
        url: target.url,
        title: target.title,
        active: target.targetId === current,
      }))
    },
    async page() {
      const list = await pages()
      const chosen = list.find((target) => target.targetId === current) ?? list[0]
      if (chosen) return attach(chosen.targetId)
      return this.open("about:blank")
    },
    async open(url) {
      const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", { url })
      return attach(targetId)
    },
    async activate(id) {
      await connection.send("Target.activateTarget", { targetId: id })
      return attach(id)
    },
    async close(id) {
      await connection.send("Target.closeTarget", { targetId: id })
      sessions.delete(id)
      if (current === id) current = undefined
    },
    async downloads(allow, dir) {
      await connection.send("Browser.setDownloadBehavior", {
        behavior: allow ? "allowAndName" : "deny",
        ...(allow ? { downloadPath: dir } : {}),
        eventsEnabled: true,
      })
    },
    onEvent: (listener) =>
      connection.on((method, params, from) => {
        if (!from) listener(method, params)
      }),
    onClose: (listener) => connection.onClose(listener),
    dispose() {
      connection.close()
      onDispose()
    },
  }
}
