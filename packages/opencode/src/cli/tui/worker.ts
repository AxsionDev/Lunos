import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ConfigOrgPolicy } from "@/config/org-policy"
import { TuiEvent } from "@/server/tui-event"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { SessionPeers } from "@/session/peers"
import { StartupTrace } from "@opencode-ai/core/startup-trace"

// XCOD-276: this worker started `performance.now()` ago; its imports have all run by now.
StartupTrace.record("load server modules", StartupTrace.now() - performance.now(), undefined, { blocking: false })

Heap.start()

const onUnhandledRejection = (_error: unknown) => {}

const onUncaughtException = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let traced = 0
let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const end =
      traced++ < 60
        ? StartupTrace.begin(`${input.method} ${new URL(input.url).pathname}`, { blocking: false })
        : undefined
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    end?.()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  /** XCOD-276: this thread's start-up phases, for the TUI's timeline. */
  trace() {
    return StartupTrace.phases()
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    // XCOD-241: once per start, when the TUI is listening: the organisation policy in use isn't
    // the console's current copy (offline, signed out, or the fetch failed).
    const notice = ConfigOrgPolicy.notice()
    if (notice)
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: TuiEvent.ToastShow.type,
          properties: { title: "Organisation policy", message: notice, variant: "warning", duration: 15000 },
        },
      })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    // XCOD-262: a worker gets no "exit" event; tell the other Lunos processes this one is gone now.
    SessionPeers.close()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
