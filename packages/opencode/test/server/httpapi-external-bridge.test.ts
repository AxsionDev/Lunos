// XCOD-254: the Lunos bridge in Claude Code and Codex sessions, through the HTTP API, against the fake
// tools (test/external/fixtures). The fakes start `lunos mcp bridge` from what Lunos hands them, as
// the real tools would, and call a Lunos MCP server's tool through it. Never runs a real tool.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Audit } from "@opencode-ai/core/audit"
import { Global } from "@opencode-ai/core/global"
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
const ECHO = path.join(FIXTURES, "fake-mcp-server.ts")

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

/** Waits for the session's next pending item at `route` (/permission or /question). */
const pending = (directory: string, sessionID: string, route: "/permission" | "/question") =>
  Effect.gen(function* () {
    for (let i = 0; i < 600; i++) {
      const all = (yield* call(directory, route)).body as any[]
      const found = all.filter((item) => item.sessionID === sessionID)
      if (found.length) return found[0]
      yield* pause
    }
    throw new Error(`nothing pending at ${route}`)
  })

const readLog = async (file: string) =>
  (await fs.readFile(file, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const audit = (file: string) =>
  Effect.promise(async () => {
    await Audit.flush()
    return readLog(file)
  })

const marker = (directory: string, sessionID: string) =>
  call(directory, pathFor(SessionPaths.get, { sessionID })).pipe(Effect.map((res) => res.body.metadata.external))

// Never the user's real home: the fakes and the bridge inherit this one, and the test checks that the
// tools' own settings in it are left exactly as they were.
let home: string
let realHome: string | undefined
const TOOL_FILES = [".claude/settings.json", ".claude.json", ".codex/config.toml"]
const digest = async () =>
  Promise.all(
    TOOL_FILES.map(async (file) =>
      createHash("sha256")
        .update(await fs.readFile(path.join(home, file)))
        .digest("hex"),
    ),
  )

beforeEach(async () => {
  realHome = process.env.HOME
  home = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-bridge-home-"))
  process.env.HOME = home
  await fs.mkdir(path.join(home, ".claude"), { recursive: true })
  await fs.mkdir(path.join(home, ".codex"), { recursive: true })
  await fs.writeFile(path.join(home, ".claude/settings.json"), JSON.stringify({ mcpServers: {}, theme: "dark" }))
  await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ projects: {} }))
  await fs.writeFile(path.join(home, ".codex/config.toml"), 'model = "gpt-5.5"\n')
  await fs.rm(path.join(Global.Path.state, "external-consent.json"), { force: true })
})

afterEach(async () => {
  process.env.HOME = realHome
  for (const key of Object.keys(process.env)) if (key.startsWith("FAKE_")) delete process.env[key]
  await fs.rm(home, { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

const ExternalConsentFile = () =>
  fs.readFile(path.join(Global.Path.state, "external-consent.json"), "utf8").catch(() => undefined)

/** A remote MCP server on 127.0.0.1, for the residency check (only remote servers send data anywhere). */
function remoteServer() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const mcp = new McpServer({ name: "far", version: "1" }, { capabilities: { tools: {} } })
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "fetch", description: "Far away", inputSchema: { type: "object", properties: {} } }],
      }))
      mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "far" }] }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await mcp.connect(transport)
      return transport.handleRequest(request)
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) }
}

/** Project config with the audit log, the echo server, and the remote one the policy refuses. */
const setup = (directory: string, remote: string, extra: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const auditPath = path.join(directory, "audit.log")
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(directory, "opencode.json"),
        JSON.stringify({
          formatter: false,
          lsp: false,
          residency: { allow: ["us"], auditPath, endpoints: { "mcp:far": { region: "other" } } },
          mcp: {
            echo: { type: "local", command: [process.execPath, ECHO] },
            far: { type: "remote", url: remote, oauth: false },
          },
          external: { claude: { path: FAKE_CLAUDE }, codex: { path: FAKE_CODEX } },
          ...extra,
        }),
      ),
    )
    yield* Effect.promise(() => disposeAllInstances())
    return auditPath
  })

describe("Lunos bridge (XCOD-254)", () => {
  it.instance(
    "Claude Code: asks once, then a Lunos MCP server's tool is called through the bridge, approved and audited in Lunos",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const remote = remoteServer()
        try {
          const auditPath = yield* setup(directory, remote.url)
          const before = yield* Effect.promise(digest)
          const log = path.join(home, "fake-claude.log")
          process.env.FAKE_CLAUDE_LOG = log
          process.env.FAKE_CLAUDE_MCP = "1"
          process.env.FAKE_CLAUDE_BRIDGE_CALL = "lunos__echo__say"
          process.env.FAKE_CLAUDE_BRIDGE_ARGS = JSON.stringify({ text: "hi" })

          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const sessionID = created.body.id as string
          const prompt = pathFor(SessionPaths.prompt, { sessionID })
          const turn = yield* call(directory, prompt, {
            agent: "build",
            parts: [{ type: "text", text: "say hi with the echo tool" }],
          }).pipe(Effect.forkChild)

          // The consent question, before anything is started.
          const question = yield* pending(directory, sessionID, "/question")
          expect(question.questions[0].question).toBe(
            "Share Lunos tools, skills and memory with Claude Code? Their results are sent to Anthropic with your prompts.",
          )
          expect(question.questions[0].options.map((item: any) => item.label)).toEqual([
            "Share",
            "Not now",
            "Never for this tool",
          ])
          expect(question.questions[0].custom).toBe(false)
          expect((yield* Effect.promise(() => readLog(log))).some((line) => line.argv?.[0] === "-p")).toBe(false)
          yield* call(directory, `/question/${question.id}/reply`, { answers: [["Share"]] })

          // The call asks in Lunos with the tool it really runs; Claude Code's own ask for it doesn't.
          const asked = yield* pending(directory, sessionID, "/permission")
          expect(asked).toMatchObject({ permission: "echo_say", metadata: { via: "lunos-bridge", server: "echo" } })
          yield* call(directory, `/permission/${asked.id}/reply`, { reply: "once" })
          const reply = yield* Fiber.join(turn)
          expect(reply.status).toBe(200)

          const lines = yield* Effect.promise(() => readLog(log))
          const run = lines.find((line) => line.argv?.[0] === "-p")
          expect(run.argv).toContain("--mcp-config")
          expect(run.argv).not.toContain("--strict-mcp-config")
          const used = lines.find((line) => line.bridge)
          expect(used.approval).toBe("allow")
          expect(used.bridge.tools).toContain("lunos__echo__say")
          // The policy refuses the remote server: not offered at all.
          expect(used.bridge.tools.some((name: string) => name.includes("far"))).toBe(false)
          expect(used.bridge.result.content).toEqual([
            { type: "text", text: `[Result from Lunos's MCP server "echo"]` },
            { type: "text", text: "said hi" },
          ])
          // The config file holding the token is gone once the turn ends.
          const file = run.argv[run.argv.indexOf("--mcp-config") + 1]
          expect(
            yield* Effect.promise(() =>
              fs.stat(file).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)

          const external = yield* marker(directory, sessionID)
          expect(external.bridge).toMatchObject({ servers: 1, memory: false, connected: true })

          const events = yield* audit(auditPath)
          expect(events.find((line) => line.event === "external.consent")).toMatchObject({
            tool: "claude",
            answer: "share",
          })
          expect(events.find((line) => line.event === "external.bridge")).toMatchObject({ tool: "claude", servers: 1 })
          expect(events.find((line) => line.event === "tool.run" && line.tool === "echo_say")).toMatchObject({
            server: "echo",
            session: sessionID,
          })

          // Asked once: the next turn, and a new session in this project, don't ask again.
          delete process.env.FAKE_CLAUDE_BRIDGE_CALL
          const second = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const again = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID: second.body.id }), {
            agent: "build",
            parts: [{ type: "text", text: "list" }],
          }).pipe(Effect.forkChild)
          for (let i = 0; i < 2; i++)
            yield* pending(directory, second.body.id, "/permission").pipe(
              Effect.flatMap((item) => call(directory, `/permission/${item.id}/reply`, { reply: "once" })),
            )
          yield* Fiber.join(again)
          const questions = (yield* call(directory, "/question")).body as any[]
          expect(questions.length).toBe(0)
          const listed = (yield* Effect.promise(() => readLog(log))).filter((line) => line.bridge)
          expect(listed.length).toBe(2)

          // Nothing under ~/.claude, ~/.claude.json or ~/.codex was written.
          expect(yield* Effect.promise(digest)).toEqual(before)
        } finally {
          remote.stop()
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )

  it.instance(
    "Never for this tool: no bridge starts, the tool runs as today, and it isn't asked again",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const remote = remoteServer()
        try {
          yield* setup(directory, remote.url)
          const log = path.join(home, "fake-claude.log")
          process.env.FAKE_CLAUDE_LOG = log
          process.env.FAKE_CLAUDE_MCP = "1"
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const sessionID = created.body.id as string
          const turn = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
            agent: "build",
            parts: [{ type: "text", text: "Create hello.txt containing hi" }],
          }).pipe(Effect.forkChild)
          const question = yield* pending(directory, sessionID, "/question")
          yield* call(directory, `/question/${question.id}/reply`, { answers: [["Never for this tool"]] })
          // The recorded turn, as before the bridge: two Write approvals.
          for (const reply of ["reject", "once"]) {
            const asked = yield* pending(directory, sessionID, "/permission")
            expect(asked.permission).toBe("external")
            yield* call(directory, `/permission/${asked.id}/reply`, { reply })
          }
          expect((yield* Fiber.join(turn)).status).toBe(200)
          const run = (yield* Effect.promise(() => readLog(log))).find((line) => line.argv?.[0] === "-p")
          expect(run.argv).not.toContain("--mcp-config")
          expect((yield* marker(directory, sessionID)).bridge.off).toMatch(/^never for this tool/)

          const next = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const second = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID: next.body.id }), {
            agent: "build",
            parts: [{ type: "text", text: "Create hello.txt containing hi" }],
          }).pipe(Effect.forkChild)
          for (const reply of ["reject", "once"]) {
            const asked = yield* pending(directory, next.body.id, "/permission")
            yield* call(directory, `/permission/${asked.id}/reply`, { reply })
          }
          yield* Fiber.join(second)
          expect(((yield* call(directory, "/question")).body as any[]).length).toBe(0)
        } finally {
          remote.stop()
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )

  it.instance(
    "Not now: no bridge in this session and not asked again in it; a new session asks again",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const remote = remoteServer()
        try {
          yield* setup(directory, remote.url)
          const log = path.join(home, "fake-claude.log")
          process.env.FAKE_CLAUDE_LOG = log
          process.env.FAKE_CLAUDE_MCP = "1"
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const sessionID = created.body.id as string
          const turn = (text: string) =>
            call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
              agent: "build",
              parts: [{ type: "text", text }],
            }).pipe(Effect.forkChild)
          const approveWrites = (id: string) =>
            Effect.gen(function* () {
              for (const reply of ["reject", "once"]) {
                const asked = yield* pending(directory, id, "/permission")
                yield* call(directory, `/permission/${asked.id}/reply`, { reply })
              }
            })
          const first = yield* turn("Create hello.txt containing hi")
          const question = yield* pending(directory, sessionID, "/question")
          yield* call(directory, `/question/${question.id}/reply`, { answers: [["Not now"]] })
          yield* approveWrites(sessionID)
          yield* Fiber.join(first)
          const external = yield* marker(directory, sessionID)
          expect(external.consent).toBe("later")
          expect(external.bridge.off).toBe("not shared in this session")

          const second = yield* turn("again")
          yield* approveWrites(sessionID)
          yield* Fiber.join(second)
          const runs = (yield* Effect.promise(() => readLog(log))).filter((line) => line.argv?.[0] === "-p")
          expect(runs.length).toBe(2)
          expect(runs.every((line) => !line.argv.includes("--mcp-config"))).toBe(true)

          const next = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const other = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID: next.body.id }), {
            agent: "build",
            parts: [{ type: "text", text: "hi" }],
          }).pipe(Effect.forkChild)
          const asked = yield* pending(directory, next.body.id, "/question")
          yield* call(directory, `/question/${asked.id}/reject`, {})
          yield* approveWrites(next.body.id)
          yield* Fiber.join(other)
          expect((yield* marker(directory, next.body.id)).consent).toBe("later")
        } finally {
          remote.stop()
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )

  it.instance(
    "stopping the turn at the consent question starts nothing",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const remote = remoteServer()
        try {
          yield* setup(directory, remote.url)
          const log = path.join(home, "fake-claude.log")
          process.env.FAKE_CLAUDE_LOG = log
          process.env.FAKE_CLAUDE_MCP = "1"
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const sessionID = created.body.id as string
          const turn = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
            agent: "build",
            parts: [{ type: "text", text: "hi" }],
          }).pipe(Effect.forkChild)
          yield* pending(directory, sessionID, "/question")
          yield* call(directory, pathFor(SessionPaths.abort, { sessionID }), {})
          yield* Fiber.join(turn)
          yield* Effect.promise(() => Bun.sleep(500))
          const runs = (yield* Effect.promise(() => readLog(log))).filter((line) => line.argv?.[0] === "-p")
          expect(runs).toEqual([])
          expect(yield* Effect.promise(() => ExternalConsentFile())).toBeUndefined()
        } finally {
          remote.stop()
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )

  it.instance(
    "a bridge that can't start leaves the tool running as today, with the reason",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const remote = remoteServer()
        const store = path.join(Global.Path.state, "external-consent.json")
        try {
          yield* setup(directory, remote.url)
          // The answer can't be saved: a directory where the file goes.
          yield* Effect.promise(() => fs.mkdir(store, { recursive: true }))
          const log = path.join(home, "fake-claude.log")
          process.env.FAKE_CLAUDE_LOG = log
          process.env.FAKE_CLAUDE_MCP = "1"
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const sessionID = created.body.id as string
          const turn = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
            agent: "build",
            parts: [{ type: "text", text: "Create hello.txt containing hi" }],
          }).pipe(Effect.forkChild)
          const question = yield* pending(directory, sessionID, "/question")
          yield* call(directory, `/question/${question.id}/reply`, { answers: [["Share"]] })
          for (const reply of ["reject", "once"]) {
            const asked = yield* pending(directory, sessionID, "/permission")
            yield* call(directory, `/permission/${asked.id}/reply`, { reply })
          }
          expect((yield* Fiber.join(turn)).status).toBe(200)
          const run = (yield* Effect.promise(() => readLog(log))).find((line) => line.argv?.[0] === "-p")
          expect(run.argv).not.toContain("--mcp-config")
          expect((yield* marker(directory, sessionID)).bridge.off).toMatch(/^couldn't start: /)
        } finally {
          remote.stop()
          yield* Effect.promise(() => fs.rm(store, { recursive: true, force: true }))
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )

  it.instance(
    "an organisation lock on external.share.mcp=false can't be overridden: the server isn't offered",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const remote = remoteServer()
        const managed = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!
        try {
          yield* Effect.promise(async () => {
            await fs.mkdir(managed, { recursive: true })
            await fs.writeFile(
              path.join(managed, "opencode.json"),
              JSON.stringify({ $locked: ["external.share.mcp"], external: { share: { mcp: false } } }),
            )
          })
          // The user tries to turn it back on.
          yield* setup(directory, remote.url, {
            external: { claude: { path: FAKE_CLAUDE }, share: { mcp: true } },
          })
          const log = path.join(home, "fake-claude.log")
          process.env.FAKE_CLAUDE_LOG = log
          process.env.FAKE_CLAUDE_MCP = "1"
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
          const sessionID = created.body.id as string
          const turn = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
            agent: "build",
            parts: [{ type: "text", text: "list" }],
          }).pipe(Effect.forkChild)
          const question = yield* pending(directory, sessionID, "/question")
          yield* call(directory, `/question/${question.id}/reply`, { answers: [["Share"]] })
          for (let i = 0; i < 2; i++) {
            const asked = yield* pending(directory, sessionID, "/permission")
            yield* call(directory, `/permission/${asked.id}/reply`, { reply: "once" })
          }
          yield* Fiber.join(turn)
          const used = (yield* Effect.promise(() => readLog(log))).find((line) => line.bridge)
          expect(used.bridge.tools.some((name: string) => name.startsWith("lunos__"))).toBe(false)
          expect((yield* marker(directory, sessionID)).bridge.servers).toBe(0)
        } finally {
          remote.stop()
          yield* Effect.promise(() => fs.rm(path.join(managed, "opencode.json"), { force: true }))
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )

  it.instance(
    "Codex: the bridge goes on the thread's config, the call is approved in Lunos, and a refused config runs as today",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const remote = remoteServer()
        try {
          const auditPath = yield* setup(directory, remote.url)
          const before = yield* Effect.promise(digest)
          const log = path.join(home, "fake-codex.log")
          process.env.FAKE_CODEX_LOG = log
          process.env.FAKE_CODEX_BRIDGE_CALL = "lunos__echo__say"
          process.env.FAKE_CODEX_BRIDGE_ARGS = JSON.stringify({ text: "from codex" })
          const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "codex" } } })
          const sessionID = created.body.id as string
          const turn = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
            agent: "build",
            parts: [{ type: "text", text: "say it" }],
          }).pipe(Effect.forkChild)
          const question = yield* pending(directory, sessionID, "/question")
          expect(question.questions[0].question).toMatch(/with Codex CLI\? Their results are sent to OpenAI/)
          yield* call(directory, `/question/${question.id}/reply`, { answers: [["Share"]] })
          const asked = yield* pending(directory, sessionID, "/permission")
          expect(asked).toMatchObject({ permission: "echo_say", metadata: { via: "lunos-bridge", tool: "codex" } })
          yield* call(directory, `/permission/${asked.id}/reply`, { reply: "once" })
          expect((yield* Fiber.join(turn)).status).toBe(200)

          const lines = yield* Effect.promise(() => readLog(log))
          const start = lines.find((line) => line.method === "thread/start")
          expect(start.params.config["mcp_servers.lunos"].args.slice(-4)).toEqual([
            "mcp",
            "bridge",
            "--session",
            sessionID,
          ])
          const used = lines.find((line) => line.bridge)
          expect(used.bridge.tools).toContain("lunos__echo__say")
          expect(used.bridge.tools.some((name: string) => name.includes("far"))).toBe(false)
          expect(used.bridge.result.content.at(-1)).toEqual({ type: "text", text: "said from codex" })
          const messages = (yield* call(directory, pathFor(SessionPaths.messages, { sessionID }))).body as any[]
          const tool = messages.flatMap((message) => message.parts).find((part: any) => part.type === "tool")
          expect(tool.tool).toBe("codex:mcp__lunos__lunos__echo__say")
          expect((yield* marker(directory, sessionID)).bridge).toMatchObject({ servers: 1, connected: true })
          const events = yield* audit(auditPath)
          expect(events.find((line) => line.event === "tool.run" && line.tool === "echo_say")).toBeTruthy()

          // A Codex that asks to approve the call to the bridge: approved at once, since the bridge asks
          // in Lunos itself (before, the unknown request was refused, declining every bridge call).
          process.env.FAKE_CODEX_BRIDGE_APPROVAL = "1"
          const approved = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
            agent: "build",
            parts: [{ type: "text", text: "say it again" }],
          }).pipe(Effect.forkChild)
          const again = yield* pending(directory, sessionID, "/permission")
          expect(again).toMatchObject({ permission: "echo_say", metadata: { via: "lunos-bridge" } })
          yield* call(directory, `/permission/${again.id}/reply`, { reply: "once" })
          expect((yield* Fiber.join(approved)).status).toBe(200)
          const approvals = (yield* Effect.promise(() => readLog(log))).filter((line) => line.approval)
          expect(approvals.map((line) => line.approval)).toEqual([{ action: "accept", content: {} }])
          delete process.env.FAKE_CODEX_BRIDGE_APPROVAL

          // A Codex that refuses config overrides: the turn still runs, without the bridge.
          delete process.env.FAKE_CODEX_BRIDGE_CALL
          process.env.FAKE_CODEX_REFUSE_CONFIG = "1"
          const next = yield* call(directory, pathFor(SessionPaths.prompt, { sessionID }), {
            agent: "build",
            parts: [{ type: "text", text: "again" }],
          }).pipe(Effect.forkChild)
          for (const reply of ["reject", "once"]) {
            const item = yield* pending(directory, sessionID, "/permission")
            yield* call(directory, `/permission/${item.id}/reply`, { reply })
          }
          expect((yield* Fiber.join(next)).status).toBe(200)
          const resumed = (yield* Effect.promise(() => readLog(log))).filter((line) => line.method === "thread/resume")
          expect(resumed.length).toBe(3)
          expect(resumed[1].params.config).toBeDefined()
          expect(resumed[2].params.config).toBeUndefined()
          expect((yield* marker(directory, sessionID)).bridge.off).toMatch(/Codex CLI refused the bridge/)

          expect(yield* Effect.promise(digest)).toEqual(before)
        } finally {
          remote.stop()
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    60_000,
  )
})
