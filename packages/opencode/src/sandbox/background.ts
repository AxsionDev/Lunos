export * as SandboxBackground from "./background"

import type { SandboxHost, SandboxState } from "@opencode-ai/tui/util/sandbox"

// XCOD-281: the sandbox starts behind the TUI. `fetch` is the TUI's whole transport (the SDK's
// server-sent events go through it too): a request made before the sandbox is ready waits for it,
// and then goes to the server inside. It never fails while waiting (the TUI's first data load would
// end Lunos) and it never goes anywhere else: if the sandbox fails, requests keep waiting and the
// caller decides what happens (start again without it, or Retry under sandbox.required). Nothing on
// this computer serves the TUI meanwhile.

type Connection = { url: string; headers: Record<string, string> }

export type Input<C extends Connection> = {
  /** Create and start the sandbox, reporting each step. */
  launch: (progress: (detail: string) => void) => Promise<C>
  /** What a failure becomes: "blocked" under sandbox.required, else "failed". Records it too. */
  failed: (error: unknown) => SandboxState
  /** Called once it's ready, before any waiting request goes through. */
  ready?: (connection: C) => SandboxState | void
  reenable?: () => void
  doctor?: () => Promise<string>
}

export function start<C extends Connection>(input: Input<C>) {
  let connection: C | undefined
  let resolve!: (connection: C) => void
  const ready = new Promise<C>((done) => (resolve = done))
  let state: SandboxState = { status: "starting" }
  const listeners = new Set<(state: SandboxState) => void>()
  const set = (next: SandboxState) => {
    state = next
    for (const listener of listeners) listener(next)
  }

  let running: Promise<void> | undefined
  function attempt() {
    if (running || connection) return running
    set({ status: "starting" })
    running = input
      .launch((detail) => {
        if (state.status === "starting") set({ status: "starting", detail })
      })
      .then(
        (started) => {
          connection = started
          set(input.ready?.(started) ?? { status: "ready", id: "" })
          resolve(started)
        },
        (error) => set(input.failed(error)),
      )
      .finally(() => (running = undefined))
    return running
  }

  /** Waits for the sandbox, or rejects when the request is cancelled. */
  function wait(signal: AbortSignal | null) {
    if (connection) return Promise.resolve(connection)
    if (!signal) return ready
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<C>((done, fail) => {
      const abort = () => fail(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      void ready.then((value) => {
        signal.removeEventListener("abort", abort)
        done(value)
      })
    })
  }

  const fetch = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init)
    const target = await wait(request.signal)
    const url = new URL(request.url)
    const next = new Request(new URL(url.pathname + url.search, target.url), request)
    for (const [name, value] of Object.entries(target.headers))
      next.headers.set(name, value)
      // As the SDK does for its own fetch: the event stream stays open for as long as the TUI runs.
    ;(next as Request & { timeout?: boolean }).timeout = false
    return globalThis.fetch(next)
  }) as typeof globalThis.fetch

  const host: SandboxHost = {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    retry() {
      if (state.status === "blocked") void attempt()
    },
    reenable: () => input.reenable?.(),
    doctor: () => input.doctor?.() ?? Promise.resolve(""),
  }

  void attempt()

  return {
    fetch,
    host,
    ready,
    /** The sandbox's connection once it's ready. */
    connection: () => connection,
    /** Settles when the current attempt does (immediately when none is running). */
    settled: () => running ?? Promise.resolve(),
  }
}
