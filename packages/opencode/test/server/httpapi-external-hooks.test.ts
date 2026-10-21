// XCOD-254: Lunos plugin hooks on a Claude Code or Codex session's own tool calls, through the HTTP
// API, against the fake tools (test/external/fixtures). A real plugin file is loaded from config; it
// refuses `rm -rf` the way a Lunos user's guard would. Never runs a real tool.
import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Database } from "@opencode-ai/core/database/database"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES = path.join(import.meta.dir, "..", "external", "fixtures")
const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude.ts")
const FAKE_CODEX = path.join(FIXTURES, "fake-codex.ts")

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const pathFor = (route: string, params: Record<string, string>) =>
  Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), route)

function call(directory: string, route: string, body?: unknown) {
  const url = new URL(route, "http://localhost")
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-opencode-directory": directory, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((text) => ({ status: response.status, body: text ? JSON.parse(text) : undefined })),
      ),
    ),
  )
}

const pause = Effect.promise(() => Bun.sleep(25))

const readLog = async (file: string) =>
  (await fs.readFile(file, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

/** The guard: logs every hook it sees, and refuses `rm -rf` in bash, as a Lunos user's plugin would. */
const PLUGIN = (log: string) => `
import { appendFileSync } from "node:fs"
const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n")
export const Guard = async () => ({
  "tool.execute.before": async (input, output) => {
    record({ hook: "before", tool: input.tool, external: input.external, callID: input.callID, args: output.args })
    if (input.tool === "bash" && /rm -rf/.test(String(output.args?.command ?? "")))
      throw new Error("rm -rf is not allowed in this project")
  },
  "tool.execute.after": async (input, output) => {
    record({ hook: "after", tool: input.tool, callID: input.callID, output: output.output })
  },
  event: async ({ event }) => {
    if (event.type === "session.idle") record({ hook: "event", type: event.type, sessionID: event.properties.sessionID })
  },
})
`

/** Project config: the plugin, the fakes, and nothing shared through the bridge (so no consent question). */
const setup = (directory: string, share: Record<string, boolean> = {}) =>
  Effect.gen(function* () {
    const hookLog = path.join(directory, "hooks.log")
    const plugin = path.join(directory, "guard-plugin.ts")
    yield* Effect.promise(() => fs.writeFile(plugin, PLUGIN(hookLog)))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          plugin: [pathToFileURL(plugin).href],
          external: {
            claude: { path: FAKE_CLAUDE },
            codex: { path: FAKE_CODEX },
            share: { mcp: false, skills: false, memory: false, ...share },
          },
        }),
      ),
    )
    yield* Effect.promise(() => disposeAllInstances())
    return hookLog
  })

/** Runs one turn; answers each Lunos approval it asks with `reply`, and returns what was asked. */
const turn = (directory: string, sessionID: string, text: string, reply: "once" | "reject" = "once") =>
  Effect.gen(function* () {
    let done = false
    const running = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
      agent: "build",
      parts: [{ type: "text", text }],
    }).pipe(Effect.ensuring(Effect.sync(() => (done = true))), Effect.forkChild)
    const asked: any[] = []
    while (!done) {
      const pending = ((yield* call(directory, "/permission")).body as any[]).filter(
        (item) => item.sessionID === sessionID,
      )
      for (const item of pending) {
        asked.push(item)
        yield* call(directory, `/permission/${item.id}/reply`, { reply })
      }
      yield* pause
    }
    const result = yield* Fiber.join(running)
    expect(result.status).toBe(200)
    return { asked, info: result.body.info }
  })

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_")) delete process.env[key]
  await disposeAllInstances()
  await resetDatabase()
})

/** The hook log once it has the session's idle event (plugins get bus events asynchronously). */
const hooksAfterIdle = (file: string, sessionID: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const lines = yield* Effect.promise(() => readLog(file))
      if (lines.some((entry) => entry.type === "session.idle" && entry.sessionID === sessionID)) return lines
      yield* pause
    }
    return yield* Effect.promise(() => readLog(file))
  })

const replies = (log: string, method?: string) =>
  readLog(log).then((lines) =>
    lines.filter((line) =>
      // XCOD-285: the answers to Lunos's policy hook (`hook_…`) are left out; only approvals count here.
      method === "claude"
        ? line.type === "control_response" && !String(line.response?.request_id).startsWith("hook_")
        : line.id !== undefined && !line.method && line.result,
    ),
  )

describe("Lunos hooks on external sessions (XCOD-254)", () => {
  it.instance(
    "Claude Code: a Lunos pre-tool hook refuses Bash rm -rf without asking; other calls ask, then run the post-tool hook",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const hookLog = yield* setup(directory)
        const log = path.join(directory, "fake-claude.log")
        process.env.FAKE_CLAUDE_LOG = log
        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
        const sessionID = created.body.id as string

        process.env.FAKE_CLAUDE_BASH = "rm -rf build"
        const refused = yield* turn(directory, sessionID, "Clean the build")
        // Refused by the hook before Lunos asked: no approval, and Claude Code is told why.
        expect(refused.asked).toEqual([])
        let sent = yield* Effect.promise(() => replies(log, "claude"))
        expect(sent.map((line) => line.response.response)).toEqual([
          { behavior: "deny", message: "Refused by a Lunos hook: rm -rf is not allowed in this project" },
        ])
        let hooks = yield* hooksAfterIdle(hookLog, sessionID)
        expect(hooks.filter((entry) => entry.hook !== "event")).toEqual([
          {
            hook: "before",
            tool: "bash",
            external: "claude",
            callID: "toolu_bash",
            args: { command: "rm -rf build", description: "Run a command" },
          },
        ])
        // Session hooks fire on the external session as on any Lunos session.
        expect(hooks).toContainEqual({ hook: "event", type: "session.idle", sessionID })

        // A harmless command passes the hook, asks in Lunos as before, and runs the post-tool hook.
        yield* Effect.promise(() => fs.rm(log, { force: true }))
        process.env.FAKE_CLAUDE_BASH = "ls"
        const allowed = yield* turn(directory, sessionID, "List files")
        expect(allowed.asked.map((item) => item.patterns[0])).toEqual(["claude:Bash ls"])
        sent = yield* Effect.promise(() => replies(log, "claude"))
        expect(sent.map((line) => line.response.response.behavior)).toEqual(["allow"])
        hooks = yield* Effect.promise(() => readLog(hookLog))
        expect(hooks.filter((entry) => entry.hook !== "event").slice(1)).toEqual([
          {
            hook: "before",
            tool: "bash",
            external: "claude",
            callID: "toolu_bash",
            args: { command: "ls", description: "Run a command" },
          },
          { hook: "after", tool: "bash", callID: "toolu_bash", output: "(ran)" },
        ])
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "Codex: a Lunos pre-tool hook refuses Bash rm -rf without asking; other calls ask, then run the post-tool hook",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const hookLog = yield* setup(directory)
        const log = path.join(directory, "fake-codex.log")
        process.env.FAKE_CODEX_LOG = log
        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "codex" } } })
        const sessionID = created.body.id as string

        process.env.FAKE_CODEX_BASH = "rm -rf build"
        const refused = yield* turn(directory, sessionID, "Clean the build")
        expect(refused.asked).toEqual([])
        let sent = yield* Effect.promise(() => replies(log))
        expect(sent.filter((line) => line.id === 900).map((line) => line.result)).toEqual([{ decision: "decline" }])
        let hooks = yield* hooksAfterIdle(hookLog, sessionID)
        expect(hooks.filter((entry) => entry.hook !== "event")).toEqual([
          { hook: "before", tool: "bash", external: "codex", callID: "cmd-1", args: { command: "rm -rf build" } },
        ])
        expect(hooks).toContainEqual({ hook: "event", type: "session.idle", sessionID })

        yield* Effect.promise(() => fs.rm(log, { force: true }))
        process.env.FAKE_CODEX_BASH = "ls"
        const allowed = yield* turn(directory, sessionID, "List files")
        expect(allowed.asked.map((item) => item.patterns[0])).toEqual(["codex:Bash ls"])
        sent = yield* Effect.promise(() => replies(log))
        expect(sent.filter((line) => line.id === 900).map((line) => line.result)).toEqual([{ decision: "accept" }])
        hooks = yield* Effect.promise(() => readLog(hookLog))
        expect(hooks.filter((entry) => entry.hook !== "event").slice(1)).toEqual([
          { hook: "before", tool: "bash", external: "codex", callID: "cmd-1", args: { command: "ls" } },
          { hook: "after", tool: "bash", callID: "cmd-1", output: "(ran)" },
        ])
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "external.share.hooks false: no tool hooks run, so rm -rf reaches the Lunos approval instead",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const hookLog = yield* setup(directory, { hooks: false })
        for (const tool of ["claude", "codex"] as const) {
          process.env[tool === "claude" ? "FAKE_CLAUDE_BASH" : "FAKE_CODEX_BASH"] = "rm -rf build"
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool } } })
          const { asked } = yield* turn(directory, created.body.id, "Clean the build", "reject")
          expect(asked.map((item) => item.patterns[0])).toEqual([`${tool}:Bash rm -rf build`])
        }
        const hooks = yield* Effect.promise(() => readLog(hookLog))
        expect(hooks.filter((entry) => entry.hook !== "event")).toEqual([])
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "Codex asking to approve an MCP tool call: asked in Lunos, through the hooks, and answered in its shape (unverified against 0.160.1)",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const hookLog = yield* setup(directory)
        const log = path.join(directory, "fake-codex.log")
        process.env.FAKE_CODEX_LOG = log
        for (const [shape, id, expected] of [
          ["elicitation", 901, { action: "accept", content: {} }],
          ["question", 902, { answers: { "mcp_tool_call_approval_mcp-9": { answers: ["Allow"] } } }],
        ] as const) {
          process.env.FAKE_CODEX_MCP_APPROVAL = shape
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "codex" } } })
          const { asked } = yield* turn(directory, created.body.id, "File a bug")
          expect(asked.map((item) => [item.patterns[0], item.metadata.action])).toEqual([
            ["codex:mcp__github__create_issue *", "mcp__github__create_issue"],
          ])
          const sent = yield* Effect.promise(() => replies(log))
          expect(sent.filter((line) => line.id === id).map((line) => line.result)).toEqual([expected])
        }
        const hooks = yield* Effect.promise(() => readLog(hookLog))
        expect(
          hooks.filter((entry) => entry.hook === "before").map((entry) => [entry.tool, entry.callID, entry.args]),
        ).toEqual([
          ["mcp__github__create_issue", "mcp-9", { title: "Bug" }],
          ["mcp__github__create_issue", "mcp-9", { title: "Bug" }],
        ])
      }),
    { git: true },
    30_000,
  )
})
