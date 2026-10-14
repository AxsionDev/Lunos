import { afterEach, beforeEach, describe, expect, test } from "bun:test"
process.env.LUNOS_CLOUD_STORE = "file"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AuditLog } from "@/audit/log"
import { CloudStore } from "@/cloud/store"
import { CloudSync } from "@/cloud/sync"
import { CloudSyncApi } from "@/cloud/sync-api"
import { CloudSyncQueue } from "@/cloud/sync-queue"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import * as Fake from "./fixtures/fake-sync-plane"

let plane: Fake.FakeSyncPlane
let tmp: string
let dir: string
let audit: string
let logs: string[]
const original = Global.Path.data
const originalAudit = AuditLog.current()

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-sync-"))
  ;(Global.Path as any).data = tmp
  dir = path.join(tmp, "project")
  await fs.mkdir(dir)
  audit = path.join(tmp, "audit.log")
  AuditLog.activate({ enabled: true, file: audit, redact: [] })
  logs = []
  plane = Fake.start()
  await CloudSyncApi.register(opts())
})
afterEach(async () => {
  plane.stop()
  await AuditLog.flush()
  AuditLog.activate(originalAudit ?? { enabled: false, file: AuditLog.DEFAULT_FILE(), redact: [] })
  ;(Global.Path as any).data = original
  await fs.rm(tmp, { recursive: true, force: true })
})

const opts = (): CloudSyncApi.Options => ({ token: async () => Fake.TOKEN, sub: Fake.SUB, endpoint: plane.url })

const S = "ses_sync1"
let clock = 0
const info = (over: Record<string, unknown> = {}) =>
  ({
    id: S,
    slug: "s",
    projectID: "prj_1",
    directory: dir,
    title: "Fix the login",
    version: "1",
    time: { created: 1, updated: 2 },
    ...over,
  }) as any as Session.Info
const user = (id: string, text = "hello") =>
  ({
    info: {
      id,
      sessionID: S,
      role: "user",
      time: { created: ++clock },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: `prt_${id}`, messageID: id, sessionID: S, type: "text", text }],
  }) as any as SessionV1.WithParts
const tool = (
  name: string,
  input: Record<string, unknown>,
  output: string,
  metadata: Record<string, unknown> = {},
) => ({
  id: `prt_${++clock}`,
  sessionID: S,
  type: "tool",
  tool: name,
  callID: `c${clock}`,
  state: { status: "completed", input, output, title: "t", metadata, time: { start: 1, end: 2 } },
})
const assistant = (id: string, parts: any[] = [], completed = true) =>
  ({
    info: {
      id,
      sessionID: S,
      role: "assistant",
      time: { created: ++clock, ...(completed ? { completed: clock } : {}) },
      providerID: "p",
      modelID: "m",
    },
    parts: parts.map((p) => ({ ...p, messageID: id })),
  }) as any as SessionV1.WithParts

function make(messages: SessionV1.WithParts[], config: CloudSync.SyncConfig = {}, session = () => info()) {
  return CloudSync.worker({
    directory: dir,
    config: async () => config,
    load: async (id) => (id === S ? { info: session(), messages } : undefined),
    opts: opts(),
    log: (_level, message) => logs.push(message),
  })
}

async function auditLines() {
  await AuditLog.flush()
  const text = await fs.readFile(audit, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const puts = () => plane.requests.filter((r) => r.method === "PUT")

describe("gates", () => {
  const state = (over: Partial<CloudSyncApi.State> = {}, device: Partial<CloudSyncApi.Device> = {}) =>
    ({
      endpoint: "https://cloud.lunos.tech",
      sub: "u",
      noticeShown: true,
      device: { id: "d", name: "n", platform: "p", syncEnabled: true, createdAt: 1, ...device },
      ...over,
    }) as CloudSyncApi.State

  test("each gate, in order", () => {
    expect(CloudSync.gates({ config: {}, state: state(), offline: true })).toEqual({ allowed: false, gate: "offline" })
    expect(CloudSync.gates({ config: {}, state: undefined, offline: false })).toEqual({
      allowed: false,
      gate: "signed-out",
    })
    expect(
      CloudSync.gates({
        config: { sync: false, $locked: ["sync"] },
        state: state({}, { syncEnabled: false }),
        offline: false,
      }),
    ).toEqual({ allowed: false, gate: "policy" })
    expect(
      CloudSync.gates({ config: { sync: false }, state: state({}, { syncEnabled: false }), offline: false }),
    ).toEqual({ allowed: false, gate: "device" })
    expect(CloudSync.gates({ config: {}, state: state({ paused: "quota" }), offline: false })).toEqual({
      allowed: false,
      gate: "device",
    })
    expect(CloudSync.gates({ config: { sync: false }, state: state(), offline: false })).toEqual({
      allowed: false,
      gate: "directory",
    })
    expect(CloudSync.gates({ config: { sync: { project: "p" } }, state: state(), offline: false })).toEqual({
      allowed: true,
    })
    expect(CloudSync.gates({ config: { $locked: ["sync"] }, state: state(), offline: false })).toEqual({
      allowed: true,
    })
  })

  test("residency: no policy allows; an EU policy allows cloud.lunos.tech and refuses an untagged host", () => {
    expect(CloudSync.residency({}, "https://elsewhere.example").allowed).toBe(true)
    expect(CloudSync.residency({ residency: { allow: ["eu"] } }, "https://cloud.lunos.tech").allowed).toBe(true)
    const r = CloudSync.residency({ residency: { allow: ["eu"] } }, "https://elsewhere.example")
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain("sync:lunos-cloud")
    // Audit-only (no policy) never refuses.
    expect(CloudSync.residency({ audit: { enabled: true } }, "https://elsewhere.example").allowed).toBe(true)
  })
})

describe("build", () => {
  test("complete messages only, sent ones skipped, no local directory, projectId from config", () => {
    const messages = [user("msg_1"), assistant("msg_2"), assistant("msg_3", [], false)]
    const first = CloudSync.build(info(), messages, undefined, { directory: dir, exclude: [], project: "p1" })
    expect(first).toHaveLength(1)
    expect(first[0]!.seq).toBe(1)
    expect(first[0]!.ids).toEqual(["msg_1", "msg_2"])
    const body = JSON.parse(first[0]!.body)
    expect(body.messages.map((m: any) => m.info.id)).toEqual(["msg_1", "msg_2"])
    expect(body.meta).toEqual({ title: "Fix the login", projectId: "p1" })
    expect("directory" in body.info).toBe(false)
    expect(first[0]!.body).not.toContain(dir)

    const cursor = { session: S, directory: dir, seq: 1, sent: first[0]!.ids }
    messages[2] = assistant("msg_3")
    const next = CloudSync.build(info(), messages, cursor, { directory: dir, exclude: [] })
    expect(next.map((c) => [c.seq, c.ids])).toEqual([[2, ["msg_3"]]])
    expect(
      CloudSync.build(
        info(),
        messages,
        { ...cursor, seq: 2, sent: ["msg_1", "msg_2", "msg_3"] },
        { directory: dir, exclude: [] },
      ),
    ).toEqual([])
  })

  test("a single message over 4 MiB has its tool output truncated to fit", () => {
    const big = assistant("msg_big", [tool("bash", { command: "cat log" }, "x".repeat(5 * 1024 * 1024))])
    const chunks = CloudSync.build(info(), [big], undefined, { directory: dir, exclude: [] })
    expect(chunks).toHaveLength(1)
    expect(Buffer.byteLength(chunks[0]!.body)).toBeLessThanOrEqual(CloudSync.LIMIT)
    expect(JSON.parse(chunks[0]!.body).messages[0].parts[0].state.output.endsWith(CloudSync.TRUNCATED)).toBe(true)
  })
})

describe("upload loop", () => {
  test("path rule end to end: the bytes the server receives hold no secret", async () => {
    await $`git init -q && git remote add origin https://someone:ghp_tokenvalue123@github.com/acme/app.git`
      .cwd(dir)
      .quiet()
    const secrets = [
      "SECRET1-envfile",
      "SECRET2-grepline",
      "SECRET3-authjson",
      "SECRET4-prodyml",
      "SECRET5-diffpatch",
      "SECRET6-revert",
      "ghp_tokenvalue123",
    ]
    const messages = [
      user("msg_1", "look around"),
      assistant("msg_2", [
        tool("read", { filePath: ".env" }, "API_KEY=SECRET1-envfile"),
        tool(
          "grep",
          { pattern: "SECRET", path: "." },
          `Found 2 matches\n${dir}/.env:\n  Line 1: TOKEN=SECRET2-grepline\n\n${dir}/src/a.ts:\n  Line 3: const SECRET = 1\n`,
        ),
        tool(
          "edit",
          { filePath: "auth.json", oldString: "{}", newString: '{"t":"SECRET3-authjson"}' },
          "Edit applied",
          {
            diff: "+SECRET3-authjson",
            filediff: { file: "auth.json", patch: "+SECRET3-authjson" },
          },
        ),
        tool("read", { filePath: "config/prod/db.yml" }, "password: SECRET4-prodyml"),
      ]),
    ]
    const session = () =>
      info({
        summary: {
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: ".env", patch: "+K=SECRET5-diffpatch", additions: 1, deletions: 0 }],
        },
        revert: { messageID: "msg_2", snapshot: "abc123", diff: "--- a/.env\n+++ b/.env\n+SECRET6-revert" },
      })
    const w = make(messages, { sync: { exclude: ["config/prod/**"], project: "p1" } }, session)
    expect(await w.turn(S)).toEqual({})
    const raw = plane.uploads()
    expect(raw).toHaveLength(1)
    for (const s of secrets) expect(raw[0]).not.toContain(s)
    expect(raw[0]).not.toContain(dir + '"')
    expect(raw[0]).toContain("[not synced: .env]")
    expect(raw[0]).toContain("src/a.ts")
    const body = JSON.parse(raw[0]!)
    expect(body.meta.repoUrl).toBe("https://github.com/acme/app.git")
    expect(body.meta.repoCommit).toBeUndefined()
    expect(body.meta.projectId).toBe("p1")
    expect(await CloudSyncQueue.pending(S)).toEqual([])
    const uploads = (await auditLines()).filter((l) => l.event === "sync.upload")
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ session: S, seq: 1, endpoint: plane.url, bytes: Buffer.byteLength(raw[0]!) })
    expect((await CloudSyncApi.load())!.device.lastSyncAt).toBeGreaterThan(0)
  })

  test("re-sending a stored seq is a no-op on the server and the client acks", async () => {
    const messages = [user("msg_1")]
    const w = make(messages)
    await w.turn(S)
    const body = plane.uploads()[0]!
    await CloudSyncQueue.enqueue(S, dir, 1, body, ["msg_1"])
    expect(await w.flush()).toEqual({})
    expect(plane.uploads()).toHaveLength(2)
    expect(plane.sessions.get(S)!.chunks.size).toBe(1)
    expect(await CloudSyncQueue.pending(S)).toEqual([])
  })

  test("a server behind the client (out_of_order): the client resyncs from the server's position", async () => {
    const messages = [user("msg_1"), assistant("msg_2")]
    const w = make(messages)
    await w.turn(S)
    plane.forget()
    messages.push(user("msg_3"), assistant("msg_4"))
    expect(await w.turn(S)).toEqual({})
    expect(plane.messages(S)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    expect(plane.sessions.get(S)!.lastSeq).toBe(1)
    const status = plane.requests.filter((r) => r.method === "GET" && r.path.includes("/sessions/"))
    expect(status).toHaveLength(1)
    expect(await CloudSyncQueue.pending(S)).toEqual([])
  })

  test("409 sync_disabled: device cached off, no more requests, one sync.denied gate=device", async () => {
    const messages = [user("msg_1")]
    const w = make(messages)
    plane.device()!.syncEnabled = false
    expect(await w.turn(S)).toEqual({})
    expect((await CloudSyncApi.load())!.device.syncEnabled).toBe(false)
    const before = plane.requests.length
    messages.push(assistant("msg_2"))
    await w.turn(S)
    await w.flush()
    expect(plane.requests.length).toBe(before)
    const denied = (await auditLines()).filter((l) => l.event === "sync.denied")
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ gate: "device", session: S })
    expect(JSON.stringify(denied[0])).not.toContain("hello")
  })

  test("410 session_deleted: the session's queue is dropped and later turns send nothing", async () => {
    const messages = [user("msg_1")]
    const w = make(messages)
    plane.deleted(S)
    await w.turn(S)
    expect((await CloudSyncQueue.cursor(S))!.stopped).toBe("deleted")
    expect(await CloudSyncQueue.pending(S)).toEqual([])
    const before = puts().length
    messages.push(assistant("msg_2"))
    await w.turn(S)
    expect(puts().length).toBe(before)
  })

  test("507: paused for quota, logged once with the fix, the next turn sends nothing", async () => {
    const messages = [user("msg_1")]
    const w = make(messages)
    plane.fail = { status: 507, code: "quota_exceeded" }
    expect(await w.turn(S)).toEqual({})
    expect((await CloudSyncApi.load())!.paused).toBe("quota")
    expect(logs).toContain(
      "Session sync paused: your Lunos space is full. Free space at https://app.lunos.tech/settings/usage, then run lunos sync on.",
    )
    plane.fail = undefined
    const before = puts().length
    messages.push(assistant("msg_2"))
    await w.turn(S)
    expect(puts().length).toBe(before)
  })

  test("403 project_archived: the session is dropped with sync.denied gate=server", async () => {
    const w = make([user("msg_1")])
    plane.fail = { status: 409, code: "project_archived" }
    await w.turn(S)
    expect((await CloudSyncQueue.cursor(S))!.stopped).toBe("denied")
    expect((await auditLines()).filter((l) => l.event === "sync.denied")).toMatchObject([
      { gate: "server", code: "project_archived" },
    ])
  })

  test("413: the chunk's seq is filled with an empty chunk, so later turns stay in order", async () => {
    const messages = [user("msg_1")]
    const w = make(messages)
    plane.fail = { status: 413, code: "too_large", times: 1 }
    expect(await w.turn(S)).toEqual({})
    expect(await CloudSyncQueue.pending(S)).toEqual([])
    expect(plane.sessions.get(S)!.lastSeq).toBe(1)
    messages.push(assistant("msg_2"))
    await w.turn(S)
    expect(plane.messages(S)).toEqual(["msg_2"])
    expect(plane.requests.filter((r) => r.method === "GET" && r.path.includes("/sessions/"))).toEqual([])

    // Refused again as the empty chunk: acked and passed over, no loop.
    plane.fail = { status: 413, code: "too_large" }
    messages.push(user("msg_3"))
    expect(await w.turn(S)).toEqual({})
    expect(await CloudSyncQueue.pending(S)).toEqual([])
  })

  test("a chunk the server rejects (400) stays queued and doesn't hold up other sessions", async () => {
    const other = "ses_sync2"
    const w = CloudSync.worker({
      directory: dir,
      config: async () => ({}),
      load: async (id) =>
        id === S
          ? { info: info(), messages: [user("msg_1")] }
          : {
              info: info({ id: other }),
              messages: [{ ...user("msg_9"), info: { ...user("msg_9").info, sessionID: other } } as any],
            },
      opts: opts(),
    })
    plane.fail = { status: 400, code: "bad_request", times: 1 }
    expect((await w.turn(S)).retryIn).toBeGreaterThan(0)
    expect(await CloudSyncQueue.pending(S)).toHaveLength(1)
    await w.turn(other)
    expect(plane.messages(other)).toEqual(["msg_9"])
    expect(await w.flush()).toEqual({})
    expect(plane.messages(S)).toEqual(["msg_1"])
  })

  test("truncation to fit never cuts ids or names", () => {
    const big = assistant("msg_big", [
      { id: "prt_" + "i".repeat(64), sessionID: S, type: "text", text: "z".repeat(5 * 1024 * 1024) },
    ])
    const body = JSON.parse(CloudSync.build(info(), [big], undefined, { directory: dir, exclude: [] })[0]!.body)
    expect(body.messages[0].parts[0].id).toBe("prt_" + "i".repeat(64))
    expect(body.messages[0].parts[0].text.endsWith(CloudSync.TRUNCATED)).toBe(true)
  })

  test("403 device_revoked deletes device.json", async () => {
    const w = make([user("msg_1")])
    plane.device()!.revokedAt = 1
    await w.turn(S)
    expect(await CloudSyncApi.load()).toBeUndefined()
    expect(await CloudSyncQueue.pending(S)).toHaveLength(1)
  })

  test("network down: the chunk stays queued; back up on the same port, flush uploads it", async () => {
    const w = make([user("msg_1")])
    plane.stop()
    const r = await w.turn(S)
    expect(r.retryIn).toBeGreaterThan(0)
    expect(await CloudSyncQueue.pending(S)).toHaveLength(1)
    plane.start()
    expect(await w.flush()).toEqual({})
    expect(await CloudSyncQueue.pending(S)).toEqual([])
    expect(plane.messages(S)).toEqual(["msg_1"])
  })

  test("a turn over 4 MiB is split into two uploads", async () => {
    const half = "y".repeat(2.5 * 1024 * 1024)
    const w = make([
      user("msg_1"),
      assistant("msg_2", [tool("bash", { command: "a" }, half)]),
      assistant("msg_3", [tool("bash", { command: "b" }, half)]),
    ])
    await w.turn(S)
    const raw = plane.uploads()
    expect(raw).toHaveLength(2)
    for (const b of raw) expect(Buffer.byteLength(b)).toBeLessThanOrEqual(CloudSync.LIMIT)
    expect(JSON.parse(raw[0]!).meta).toBeDefined()
    expect(JSON.parse(raw[1]!).meta).toBeUndefined()
    expect(plane.messages(S)).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  test("a residency refusal sends nothing and is audited once with gate=residency", async () => {
    const w = make([user("msg_1")], { residency: { allow: ["eu"], auditPath: audit } })
    await w.turn(S)
    await w.turn(S)
    expect(puts()).toEqual([])
    const denied = (await auditLines()).filter((l) => l.event === "sync.denied")
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ gate: "residency", session: S, providerID: "sync:lunos-cloud", allowed: false })
  })

  test("policy and directory refusals are audited once per session; offline writes nothing", async () => {
    const w = make([user("msg_1")], { sync: false, $locked: ["sync"] })
    await w.turn(S)
    await w.turn(S)
    const d = make([user("msg_1")], { sync: false })
    await d.turn(S)
    process.env.LUNOS_OFFLINE = "1"
    try {
      await make([user("msg_1")]).turn(S)
    } finally {
      delete process.env.LUNOS_OFFLINE
    }
    expect(puts()).toEqual([])
    expect((await auditLines()).filter((l) => l.event === "sync.denied").map((l) => l.gate)).toEqual([
      "policy",
      "directory",
    ])
  })
})

describe("service", () => {
  const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node])))
  const layer = LayerNode.compile(
    LayerNode.group([CloudSync.node, EventV2Bridge.node, Session.node, SessionProjector.node, Database.node]),
  )

  it.live(
    "an idle session uploads its turn",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            CloudStore.save({
              issuer: plane.issuer,
              clientID: "lunos-cli",
              tokens: { access_token: Fake.TOKEN, token_type: "Bearer" },
              sub: Fake.SUB,
              savedAt: new Date().toISOString(),
            }),
          )
          const session = yield* Session.Service
          const sync = yield* CloudSync.Service
          const events = yield* EventV2Bridge.Service
          yield* sync.init()
          const created = yield* session.create({ title: "wired" })
          yield* session.updateMessage({
            id: MessageID.make("msg_wired1"),
            sessionID: created.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
          } as SessionV1.User)
          yield* events.publish(SessionStatus.Event.Status, { sessionID: created.id, status: { type: "idle" } })
          yield* pollWithTimeout(
            Effect.sync(() => (plane.messages(created.id).length ? true : undefined)),
            "timed out waiting for the sync upload",
            "10 seconds",
          )
          expect(plane.messages(created.id)).toEqual(["msg_wired1"])
          expect(puts()[0]!.auth).toBe(`Bearer ${Fake.TOKEN}`)
        }).pipe(Effect.provide(layer)),
      ),
    20_000,
  )
})
