// XCOD-191: the route behind the TUI's /share with "share": "cloud". The same code as `lunos share`:
// the console's declared region is checked first, the upload is audited as share.upload, a refusal is a
// 403 with a message (never a 500), and the session is not marked shared (that is upstream's service).
import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Audit } from "@opencode-ai/core/audit"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
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

let dir: string
let previousData: string
let previousManaged: string | undefined
let region = "eu"
const all: Array<{ method: string; path: string; body?: any }> = []
// The organisation policy (XCOD-238) is fetched as config loads; only the share traffic matters here.
const received = {
  map: <T>(fn: (r: (typeof all)[number]) => T) => all.filter((r) => !r.path.endsWith("/policy")).map(fn),
  filter: (fn: (r: (typeof all)[number]) => boolean) => all.filter((r) => !r.path.endsWith("/policy")).filter(fn),
  at: (i: number) => all.filter((r) => !r.path.endsWith("/policy")).at(i),
}
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-share-console-")))
  process.env.LUNOS_CLOUD_STORE = "file"
  previousData = Global.Path.data
  ;(Global.Path as { data: string }).data = path.join(dir, "data")
  previousManaged = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = path.join(dir, "managed")
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json() : undefined
      all.push({ method: req.method, path: url.pathname, body })
      if (req.headers.get("authorization") !== "Bearer fake-token") return new Response(null, { status: 401 })
      if (url.pathname === "/v1") return Response.json({ api: "1", region })
      if (url.pathname === "/v1/orgs/acme/shares" && req.method === "POST")
        return Response.json(
          {
            id: "abc",
            url: `http://127.0.0.1:${server.port}/orgs/acme/shares/abc`,
            sha256: "x",
            ...(body.link ? { link: { url: "http://127.0.0.1/s/tok", expiresAt: "2026-11-12T00:00:00.000Z" } } : {}),
          },
          { status: 201 },
        )
      return new Response(null, { status: 404 })
    },
  })
  await fs.mkdir(path.join(dir, "managed"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "managed", "managed.json"),
    JSON.stringify({ cloud: { policy: `http://127.0.0.1:${server.port}/v1/orgs/acme/policy` } }),
  )
  await fs.mkdir(path.join(dir, "data", "cloud"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "data", "cloud", "session.json"),
    JSON.stringify({
      issuer: "http://127.0.0.1:9/realms/test",
      clientID: "lunos-cli",
      tokens: { access_token: "fake-token", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
      sub: "tester",
      savedAt: new Date().toISOString(),
    }),
  )
})

afterAll(async () => {
  server.stop(true)
  ;(Global.Path as { data: string }).data = previousData
  if (previousManaged === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousManaged
  delete process.env.LUNOS_CLOUD_STORE
  await fs.rm(dir, { recursive: true, force: true })
})

afterEach(async () => {
  all.length = 0
  region = "eu"
  await disposeAllInstances()
  await resetDatabase()
})

const auditFile = () => path.join(dir, "audit.log")

function share(directory: string, sessionID: string, body: unknown) {
  const url = new URL(SessionPaths.shareConsole.replace(":sessionID", sessionID), "http://localhost")
  return HttpClientRequest.fromWeb(
    new Request(url, {
      method: "POST",
      headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ).pipe(HttpClientRequest.setUrl(url.pathname), HttpClient.execute)
}

const events = Effect.promise(async () => {
  await Audit.flush()
  await Bun.sleep(100)
  return (await fs.readFile(auditFile(), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
})

describe("POST /session/:sessionID/share/console", () => {
  it.instance(
    "uploads the session (redacted when asked) to an EU console, with a default link, audited as share.upload",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "Fix the login bug" })
        const response = yield* share(test.directory, session.id, { sanitize: true, link: true })
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({
          org: "acme",
          host: `127.0.0.1:${server.port}`,
          id: "abc",
          url: `http://127.0.0.1:${server.port}/orgs/acme/shares/abc`,
          link: { url: "http://127.0.0.1/s/tok", expiresAt: "2026-11-12T00:00:00.000Z" },
        })
        expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1", "POST /v1/orgs/acme/shares"])
        const post = received.at(1)!.body
        expect(post).toMatchObject({ kind: "session", title: "Fix the login bug", link: {} })
        expect(post.content.info.title).toStartWith("[redacted:session-title:")
        expect((yield* events).filter((e) => e.event === "share.upload")).toHaveLength(1)
        // Not marked shared: that would offer upstream's unshare for it.
        expect((yield* Session.use.get(session.id)).share).toBeUndefined()
      }),
    { config: () => ({ share: "cloud", residency: { allow: ["eu"] }, audit: { enabled: true, path: auditFile() } }) },
  )

  it.instance(
    "a console that declares us is refused with a 403 and a message; nothing is uploaded",
    () =>
      Effect.gen(function* () {
        region = "us"
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "t" })
        const response = yield* share(test.directory, session.id, {})
        expect(response.status).toBe(403)
        const body = (yield* response.json) as { _tag: string; message: string }
        expect(body._tag).toBe("ShareDisabledError")
        expect(body.message).toContain("blocked by the data-residency policy")
        expect(received.filter((r) => r.method === "POST")).toEqual([])
      }),
    { config: { share: "cloud", residency: { allow: ["eu"] } } },
  )

  it.instance(
    "sharing off: refused with how to turn it on",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "t" })
        const response = yield* share(test.directory, session.id, {})
        expect(response.status).toBe(403)
        expect(((yield* response.json) as { message: string }).message).toContain("lunos settings set share cloud")
        expect(received.map((r) => r.path)).toEqual([])
      }),
    { config: { share: "disabled" } },
  )
})
