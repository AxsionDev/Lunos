import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "@opencode-ai/tui/context/sdk"
import { writeHeapSnapshot } from "v8"
import { ServerAuth } from "@/server/auth"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"
import type { RestartRequest } from "@opencode-ai/tui/util/restart"
import type { SandboxState } from "@opencode-ai/tui/util/sandbox"
import { Restart } from "../restart"
import { CloudGate } from "@/cloud/gate"
import { CloudTuiHost } from "@/cloud/tui-host"
import { requireLineSignIn } from "./cloud"
import { StartupTrace } from "@opencode-ai/core/startup-trace"
import { RunLog } from "@opencode-ai/core/observability/run-log"
import { Failure } from "../failure"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

/**
 * XCOD-276: `lunos debug startup` sets `quit`: the TUI quits once the timeline is complete. `settle`
 * is how long after the first frame the timeline keeps collecting, so work behind it shows up too.
 */
export const startupProbe: { settle: number; quit?: boolean } = { settle: 3000 }

/**
 * Once the first frame is up and the work behind it had `settle` ms: adds the server's phases and
 * writes the timeline to its file. Printed to the terminal only after the TUI has left it.
 */
async function collectStartupTrace(client: RpcClient | undefined) {
  await StartupTrace.waitFirstFrame()
  await Bun.sleep(startupProbe.settle)
  // XCOD-281: with the sandbox starting behind the TUI there is no worker here.
  if (client) StartupTrace.add(await withTimeout(client.call("trace", undefined), 1000).catch(() => []))
  const file = StartupTrace.target()
  if (file) await Bun.write(file, StartupTrace.serialize(file)).catch(() => {})
}

/** The worker that runs the server, MCP, LSP and the memory sidecar on this computer. */
function startWorker(file: string | URL) {
  const begun = StartupTrace.begin("start worker")
  // XCOD-280: the worker writes into this run's log (it takes RunLog.ENV out of its environment, so
  // its children don't get it). XCOD-276: it reports its start-up phases on this process's clock.
  const worker = new Worker(file, {
    env: Object.fromEntries(
      Object.entries(process.env)
        .concat([[RunLog.ENV, RunLog.current()?.file]], Object.entries(StartupTrace.originEnv()))
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  })
  begun()
  const client = Rpc.client<typeof rpc>(worker)
  const reload = () => {
    client.call("reload", undefined).catch(() => {})
  }
  process.on("SIGUSR2", reload)

  let stopped = false
  // XCOD-280: the worker runs the server, MCP, LSP and the memory sidecar. If it dies, the TUI
  // can't go on: put the terminal back and say where the log is.
  const crashed = (error: unknown) => {
    if (stopped) return
    stopped = true
    Failure.record("the worker", error, "Lunos's background worker stopped unexpectedly.")
    process.exit(1)
  }
  worker.addEventListener("error", (event) => crashed(event.error ?? new Error(event.message)))
  worker.addEventListener("close", () => crashed(new Error("The worker thread exited")))
  const stop = async () => {
    if (stopped) return
    stopped = true
    process.off("SIGUSR2", reload)
    await withTimeout(client.call("shutdown", undefined), 5000).catch(() => {})
    worker.terminate()
  }
  return { client, stop }
}

/**
 * XCOD-281: how a restart relaunches. After the sandbox failed: without it, carrying the failure for
 * the toast. A Retry: with it. A sandboxed session doesn't outlive its sandbox (its results were
 * just handed back), so a sandboxed restart starts a new session.
 */
export function relaunchFor(
  request: RestartRequest,
  sandbox?: SandboxState,
): [RestartRequest, undefined?, { sandbox?: Restart.Handoff["sandbox"] }?] {
  const fresh = { ...request, sessionID: undefined, fresh: true }
  if (request.sandbox === "failed" && sandbox?.status === "failed")
    return [fresh, undefined, { sandbox: { failed: sandbox.failure } }]
  if (request.sandbox === "retry") return [fresh, undefined, { sandbox: { retry: true } }]
  if (sandbox && sandbox.status !== "off") return [fresh]
  return [request]
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("mode", {
        type: "string",
        describe: "mode to use",
      })
      .option("agent", {
        type: "string",
        hidden: true,
        describe: "deprecated, use --mode",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      })
      .option("sandbox", {
        type: "boolean",
        describe: "run in an isolated Docker sandbox; results come back as branch lunos/sandbox/<id>",
      })
      .option("keep", {
        type: "boolean",
        describe: "with --sandbox: keep the sandbox when done, whatever sandbox.on_finish says",
      })
      .option("rm", {
        type: "boolean",
        describe: "with --sandbox: remove the sandbox when done, whatever sandbox.on_finish says",
      }),
  handler: async (args) => {
    // XCOD-129: taken before anything else, so the worker and its children never inherit it.
    const restarted = Restart.takeHandoff()
    StartupTrace.mark("tui command", { blocking: true })
    // XCOD-144: the server and everything it spawns run in a container; only the TUI stays here.
    const { startsSandboxed, sandboxTui, sandboxOff, refuseHost } = await StartupTrace.span(
      "import sandbox",
      () => import("./sandbox"),
    )
    if (args.sandbox === false) {
      const refused = await refuseHost("`lunos --no-sandbox`", resolveThreadDirectory(args.project))
      if (refused) {
        UI.error(refused)
        process.exitCode = 1
        return
      }
    }
    // XCOD-281: the sandbox starts behind the TUI, which talks to nothing else meanwhile.
    let sandbox: Awaited<ReturnType<typeof sandboxTui>> | undefined
    if (
      StartupTrace.trace("sandbox decision", () =>
        startsSandboxed(args, resolveThreadDirectory(args.project), restarted?.sandbox),
      )
    ) {
      const unsupported = [
        ["--mini", args.mini],
        ["--prompt", args.prompt !== undefined],
        ["--model", args.model !== undefined],
        ["--mode", args.mode !== undefined || args.agent !== undefined],
        ["--port", hasArg("--port")],
        ["--hostname", hasArg("--hostname")],
      ].find((entry) => entry[1])?.[0]
      if (unsupported) {
        UI.error(`${unsupported} cannot be used with --sandbox yet`)
        process.exitCode = 1
        return
      }
      // XCOD-273: the official build's account check, in line mode (no Welcome screen here yet).
      if (!(await requireLineSignIn())) {
        process.exitCode = 1
        return
      }
      try {
        sandbox = await sandboxTui(resolveThreadDirectory(args.project), { keep: args.keep, rm: args.rm }, restarted)
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }
    }
    // XCOD-281: on this computer because the sandbox failed (now, or on an earlier start): the badge,
    // and right after the failure the toast.
    const sandboxHost =
      sandbox?.host ?? sandboxOff(resolveThreadDirectory(args.project), restarted?.sandbox, restarted?.queued)
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    // XCOD-40: --agent is deprecated in favor of --mode; --mode wins if both are set.
    if (args.agent && !args.mode) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL, `--agent is deprecated, use --mode instead`)
    }
    const modeArg = args.mode ?? args.agent

    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }

      // XCOD-273: --mini has no Welcome screen; the same sign-in runs in line mode first.
      if (!(await requireLineSignIn())) {
        process.exitCode = 1
        return
      }
      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        mode: modeArg,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const unguard = win32InstallCtrlCGuard()
    let restartRequest: RestartRequest | undefined
    // A relaunch that hasn't loaded its session within the timeout gives up, once, with the manual
    // command, rather than hanging on a blank screen.
    const watchdog = restarted
      ? setTimeout(() => {
          Restart.write(Restart.TERMINAL_RESET + "\x1b[?1049l")
          process.stderr.write(`Lunos didn't finish starting within ${Restart.START_TIMEOUT / 1000}s.\n`)
          Restart.reportFailedStart()
          process.exit(1)
        }, Restart.START_TIMEOUT)
      : undefined
    watchdog?.unref?.()
    try {
      const { TuiConfig } = await StartupTrace.span("import tui config", () => import("@/config/tui"))
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await StartupTrace.span("find worker", target)
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      // XCOD-281: sandboxed, the server and everything it starts run in the container; no worker here.
      const worker = sandbox ? undefined : startWorker(file)
      const client: RpcClient | undefined = worker?.client
      const stop = async () => worker?.stop()

      const collected = StartupTrace.enabled() ? collectStartupTrace(client) : undefined
      const prompt = await StartupTrace.span("read piped input", () => input(args.prompt))
      const config = await StartupTrace.span("tui config", () => TuiConfig.get())

      const network = resolveNetworkOptionsNoConfig(args)
      const external = hasArg("--port") || hasArg("--hostname") || network.mdns === true

      const headers = external ? ServerAuth.headers() : undefined

      const transport = sandbox
        ? { url: "http://opencode.internal", fetch: sandbox.fetch, events: undefined, headers: undefined }
        : external
          ? {
              url: (await client!.call("server", network)).url,
              fetch: undefined,
              events: undefined,
              headers,
            }
          : {
              url: "http://opencode.internal",
              fetch: createWorkerFetch(client!),
              events: createEventSource(client!),
            }

      // XCOD-281: the sandbox's server isn't there yet; a session that doesn't exist opens as an error there.
      if (!sandbox)
        try {
          await StartupTrace.span("validate session", () =>
            validateSession({
              url: transport.url,
              sessionID: args.session,
              directory: cwd,
              fetch: transport.fetch,
              headers,
            }),
          )
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }

      // XCOD-147: the update check announces its result with a one-off event. Sent before the TUI
      // listens, it was silently lost, so a fast (or cached) answer never reached the screen. With
      // the in-process worker the check starts once the TUI is listening; an external server keeps
      // the old delay.
      const checkUpgrade = () => void client?.call("checkUpgrade", { directory: cwd }).catch(() => {})
      if (external) setTimeout(checkUpgrade, 1000).unref?.()
      // XCOD-281: a slow image pull isn't a failed start: a relaunch counts as started at its first frame.
      if (sandbox)
        void StartupTrace.waitFirstFrame().then(() => {
          clearTimeout(watchdog)
          Restart.markStarted()
        })

      try {
        const imported = StartupTrace.begin("import tui")
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        imported()
        const gate = await StartupTrace.span("sign-in gate", () => CloudGate.current())
        Failure.setFullscreen(true)
        await Effect.runPromise(
          run({
            url: transport.url,
            onListening: external || sandbox ? undefined : checkUpgrade,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              if (!client) return [tui]
              const server = await client.call("snapshot", undefined)
              return [tui, server]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            restart: { request: (request) => (restartRequest = request) },
            restarted: restarted && { ...restarted },
            quit: startupProbe.quit ? collected : undefined,
            onStarted() {
              clearTimeout(watchdog)
              Restart.markStarted()
            },
            directory: sandbox?.directory ?? cwd,
            sandbox: sandboxHost,
            fetch: transport.fetch,
            headers: transport.headers,
            events: transport.events,
            // XCOD-273: the Lunos account, run here in the CLI process (the Welcome screen's sign-in).
            account: CloudTuiHost.create(gate),
            args: {
              continue: args.continue,
              sessionID: args.session,
              mode: modeArg,
              model: args.model,
              prompt,
              fork: args.fork,
              auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
              // XCOD-128: `lunos settings` starts here, on the settings screen.
              settings: (args as { settings?: "settings" }).settings,
            },
          }),
        )
      } finally {
        Failure.setFullscreen(false)
        await stop()
      }
    } finally {
      clearTimeout(watchdog)
      try {
        unguard?.()
      } catch {}
    }
    // `lunos debug startup` prints it as its output; LUNOS_STARTUP_TRACE=1 alongside the TUI's.
    if (StartupTrace.enabled() && !StartupTrace.target())
      (startupProbe.quit ? process.stdout : process.stderr).write(StartupTrace.format() + "\n")
    // XCOD-281: the sandbox's results come back (or a sandbox still starting is kept) before anything else.
    await sandbox?.finish()
    if (process.exitCode) Restart.reportFailedStart()
    // XCOD-129: the TUI has exited and the worker (MCP, LSP, memory sidecar, local server) is shut
    // down; start Lunos again in its place.
    else if (restartRequest) await Restart.relaunch(...relaunchFor(restartRequest, sandbox?.host.state()))
    process.exit()
  },
})
// scratch
