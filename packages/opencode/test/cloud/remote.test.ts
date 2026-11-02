// XCOD-338: remote control, the computer's side. A small fake of the control plane's relay (the real
// one is tested in lunoshq: test/remote.test.ts and test/e2e-remote.test.ts) and the process's own API
// as a stub that records what it was asked, as test/session/peer-control.test.ts does.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { GlobalEvent } from "@/bus/global"
import { AuditLog } from "@/audit/log"
import { CloudRemote } from "@/cloud/remote"
import { CloudRemoteLink } from "@/cloud/remote-link"
import { CloudSyncApi } from "@/cloud/sync-api"

type Relay = ReturnType<typeof fakeRelay>

function fakeRelay() {
  const events: Array<{ type: string; key?: string; data: any }> = []
  let commands: CloudRemoteLink.Command[] = []
  let ended: string | undefined
  let opened: any
  const hosts: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get("authorization") !== "Bearer t0k") return Response.json({ error: { code: "unauthenticated" } }, { status: 401 })
      if (url.pathname === "/v1/remote/links" && req.method === "POST") {
        opened = await req.json()
        return Response.json(
          { id: "rl_1", host: "a".repeat(64), session: opened.session, device: opened.device, createdAt: Date.now(), expiresAt: Date.now() + 12 * 3_600_000 },
          { status: 201 },
        )
      }
      hosts.push(req.headers.get("x-lunos-remote-host") ?? "")
      if (ended) return Response.json({ error: { code: "remote_ended", message: "This remote session was revoked.", details: { reason: ended } } }, { status: 410 })
      if (url.pathname === "/v1/remote/links/rl_1/events" && req.method === "POST") {
        events.push(...((await req.json()) as any).events)
        return Response.json({ seq: events.length })
      }
      if (url.pathname === "/v1/remote/links/rl_1/commands") {
        for (let i = 0; i < 20 && !commands.length && !ended; i++) await Bun.sleep(25)
        if (ended) return Response.json({ error: { code: "remote_ended", details: { reason: ended } } }, { status: 410 })
        const out = commands
        commands = []
        return Response.json({ commands: out })
      }
      if (url.pathname === "/v1/remote/links/rl_1" && req.method === "DELETE") {
        ended = "off"
        return Response.json({ ended: true })
      }
      return Response.json({ error: { code: "no_route" } }, { status: 404 })
    },
  })
  return {
    url: server.url.origin,
    events,
    hosts,
    opened: () => opened,
    ended: () => ended,
    send: (c: Partial<CloudRemoteLink.Command> & { type: CloudRemoteLink.Command["type"] }) =>
      commands.push({ id: `cmd_${commands.length + 1}`, at: Date.now(), ...c } as CloudRemoteLink.Command),
    revoke: () => (ended = "revoked"),
    stop: () => server.stop(true),
  }
}

/** The process's own API: two pending permissions (one of this session's subagent) and one of another session. */
function fakeApi() {
  const calls: Array<{ method: string; path: string; body?: string }> = []
  const api = async (p: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: p, ...(init?.body ? { body: String(init.body) } : {}) })
    if (p === "/permission")
      return Response.json([
        { id: "per_1", sessionID: "ses_1" },
        { id: "per_child", sessionID: "ses_child" },
        { id: "per_other", sessionID: "ses_other" },
      ])
    if (p === "/question") return Response.json([{ id: "que_1", sessionID: "ses_1", questions: [{ question: "Which?", options: [{ label: "A" }] }] }])
    if (p === "/session/ses_1") return Response.json({ id: "ses_1", title: "Fix the bug" })
    if (p.startsWith("/session/ses_1/message")) return Response.json([])
    return Response.json(true)
  }
  return { api, calls }
}

let tmp: string
let audit: string
let relay: Relay
const original = Global.Path.data
const originalAudit = AuditLog.current()
let listeners: Array<(e: GlobalEvent) => void>
const emit = (payload: any) => listeners.forEach((l) => l({ directory: "/work", payload }))

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-remote-"))
  ;(Global.Path as any).data = tmp
  audit = path.join(tmp, "audit.log")
  AuditLog.activate({ enabled: true, file: audit, redact: [] })
  relay = fakeRelay()
  listeners = []
  await CloudSyncApi.save({
    endpoint: relay.url,
    sub: "ada",
    noticeShown: true,
    device: { id: "dev_mac", name: "mac", platform: "darwin", syncEnabled: true, createdAt: 1 },
  })
})
afterEach(async () => {
  for (const id of CloudRemote.list()) await CloudRemote.disable(id)
  relay.stop()
  await AuditLog.flush()
  AuditLog.activate(originalAudit ?? { enabled: false, file: AuditLog.DEFAULT_FILE(), redact: [] })
  ;(Global.Path as any).data = original
  await fs.rm(tmp, { recursive: true, force: true })
})

const auditLines = async () => {
  await AuditLog.flush()
  const text = await fs.readFile(audit, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

async function turnOn(over: Partial<CloudRemote.EnableInput> = {}) {
  const api = fakeApi()
  const marked: string[] = []
  const prompts: Array<{ text: string; interrupt: boolean }> = []
  let stopped = 0
  const status = await CloudRemote.enable({
    sessionID: "ses_1",
    directory: "/work",
    config: {},
    title: "Fix the bug",
    opts: { endpoint: relay.url, token: async () => "t0k" },
    deps: {
      api: api.api,
      mark: (id) => marked.push(id),
      submit: async (text, interrupt) => {
        prompts.push({ text, interrupt })
        return { delivery: interrupt ? "interrupted" : "queued" }
      },
      stop: async () => void stopped++,
      subscribe: (l) => {
        listeners.push(l)
        return () => (listeners = listeners.filter((x) => x !== l))
      },
    },
    ...over,
  })
  return { status, api, marked, prompts, stopped: () => stopped }
}

const until = async (fn: () => boolean, ms = 3_000) => {
  for (let t = 0; t < ms && !fn(); t += 20) await Bun.sleep(20)
  expect(fn()).toBe(true)
}

describe("CloudRemote.gate (XCOD-338)", () => {
  const state = (over: Partial<CloudSyncApi.Device> = {}): CloudSyncApi.State => ({
    endpoint: "https://cloud.lunos.tech",
    sub: "ada",
    noticeShown: true,
    device: { id: "dev_1", name: "mac", platform: "darwin", syncEnabled: true, createdAt: 1, ...over },
  })
  const ok = { config: {}, offline: false, signedIn: true, state: state() }
  test("off by default for nobody: on once signed in with a registered device that syncs", () => {
    expect(CloudRemote.gate(ok)).toBeUndefined()
  })
  test("each gate, in order", () => {
    expect(CloudRemote.gate({ ...ok, offline: true })).toBe("offline")
    expect(CloudRemote.gate({ ...ok, config: { remote_control: false, $locked: ["remote_control"] } })).toBe("policy")
    // An organisation with sync: false (locked) has remote control off too.
    expect(CloudRemote.gate({ ...ok, config: { sync: false, $locked: ["sync"] } })).toBe("policy")
    expect(CloudRemote.gate({ ...ok, config: { remote_control: false } })).toBe("directory")
    expect(CloudRemote.gate({ ...ok, config: { sync: false } })).toBe("directory")
    expect(CloudRemote.gate({ ...ok, signedIn: false })).toBe("signed-out")
    expect(CloudRemote.gate({ ...ok, state: undefined })).toBe("not-registered")
    expect(CloudRemote.gate({ ...ok, state: state({ syncEnabled: false }) })).toBe("device")
    expect(CloudRemote.gate({ ...ok, state: state({ revokedAt: 5 }) })).toBe("device")
  })
  test("a refusal says why and is audited; nothing is sent to the relay", async () => {
    await expect(turnOn({ config: { sync: false, $locked: ["sync"] } })).rejects.toThrow("organisation's policy")
    expect(relay.opened()).toBeUndefined()
    expect(await auditLines()).toContainEqual(expect.objectContaining({ event: "remote.denied", session: "ses_1", gate: "policy" }))
  })
})

describe("CloudRemote bridge (XCOD-338)", () => {
  test("on: opens a link for this device and session, sends the snapshot (session, pending approvals), audits remote.on", async () => {
    const r = await turnOn()
    expect(r.status).toMatchObject({ on: true, link: "rl_1", url: "https://app.lunos.tech/remote/rl_1" })
    expect(relay.opened()).toEqual({ device: "dev_mac", session: "ses_1", title: "Fix the bug" })
    await until(() => relay.events.some((e) => e.type === "permission.asked"))
    // Only this session's asks and its subagents' (once the subagent is known); never another session's.
    expect(relay.events.filter((e) => e.type === "permission.asked").map((e) => e.data.id)).toEqual(["per_1"])
    expect(relay.events.find((e) => e.type === "question.asked")?.data.questions[0].question).toBe("Which?")
    // Every relay call after open carries the host secret.
    expect(relay.hosts.every((h) => h === "a".repeat(64))).toBe(true)
    expect(await auditLines()).toContainEqual(expect.objectContaining({ event: "remote.on", session: "ses_1", link: "rl_1", device: "dev_mac" }))
  })

  test("AC1: an approval from the web is checked, marked via remote, answered through the process's own permission route, and audited", async () => {
    const r = await turnOn()
    relay.send({ type: "permission", requestID: "per_1", reply: "once" })
    await until(() => r.api.calls.some((c) => c.path === "/permission/per_1/reply"))
    expect(r.marked).toEqual(["per_1"])
    expect(r.api.calls.find((c) => c.path === "/permission/per_1/reply")).toEqual({
      method: "POST",
      path: "/permission/per_1/reply",
      body: JSON.stringify({ reply: "once" }),
    })
    await until(() => relay.events.some((e) => e.type === "command.result"))
    expect(relay.events.find((e) => e.type === "command.result")?.data).toMatchObject({ kind: "permission", ok: true })
    expect(await auditLines()).toContainEqual(
      expect.objectContaining({ event: "remote.command", session: "ses_1", kind: "permission", request: "per_1", reply: "once", via: "remote", ok: true }),
    )
  })

  test("another session's approval is refused; a subagent's is answered once the subagent is known", async () => {
    const r = await turnOn()
    relay.send({ type: "permission", requestID: "per_other", reply: "always" })
    relay.send({ type: "permission", requestID: "per_child", reply: "once" })
    await until(() => relay.events.filter((e) => e.type === "command.result").length === 2)
    expect(r.api.calls.some((c) => c.path.startsWith("/permission/per_other"))).toBe(false)
    expect(r.api.calls.some((c) => c.path.startsWith("/permission/per_child"))).toBe(false)
    expect(r.marked).toEqual([])

    emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_1", title: "explore" } } })
    relay.send({ type: "permission", requestID: "per_child", reply: "once" })
    await until(() => r.api.calls.some((c) => c.path === "/permission/per_child/reply"))
    expect(r.marked).toEqual(["per_child"])
  })

  test("prompts, questions, stop and interrupt go to the session's own queue and routes", async () => {
    const r = await turnOn()
    relay.send({ type: "prompt", text: "and add a test", queue: true })
    relay.send({ type: "prompt", text: "stop that, do this", queue: false })
    relay.send({ type: "question", requestID: "que_1", answers: [["A"]] })
    relay.send({ type: "interrupt" })
    relay.send({ type: "stop" })
    await until(() => r.stopped() === 1)
    expect(r.prompts).toEqual([
      { text: "and add a test", interrupt: false },
      { text: "stop that, do this", interrupt: true },
    ])
    expect(r.api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/question/que_1/reply", "/session/ses_1/abort"])
    // The audit never holds the prompt text.
    expect(JSON.stringify(await auditLines())).not.toContain("add a test")
  })

  test("a command older than its TTL is dropped, never run late", async () => {
    const r = await turnOn()
    relay.send({ type: "permission", requestID: "per_1", reply: "always", at: Date.now() - CloudRemote.COMMAND_TTL_MS - 1 } as never)
    await until(() => relay.events.some((e) => e.type === "command.result"))
    expect(relay.events.find((e) => e.type === "command.result")?.data).toMatchObject({ ok: false })
    expect(r.marked).toEqual([])
  })

  test("what the web sees follows the sync rules: never-upload files, the scanner, and secrets split across streamed deltas", async () => {
    await turnOn()
    emit({ type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_1", sessionID: "ses_1", role: "assistant", providerID: "anthropic", modelID: "claude", cost: 0.12, tokens: { input: 10, output: 5 } } } })
    emit({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: ".env" }, output: "DB_PASSWORD=hunter2" } },
      },
    })
    emit({ type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "prt_2", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "export API_KEY=sk-abcdef" } } })
    emit({ type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_2", field: "text", delta: "ghijklmnop1234" } })
    // Another session's events never go.
    emit({ type: "message.part.updated", properties: { sessionID: "ses_other", part: { id: "prt_9", messageID: "msg_9", sessionID: "ses_other", type: "text", text: "not mine" } } })
    await until(() => relay.events.some((e) => e.key === "part:prt_2" && String(e.data.text).length > 20))
    const sent = JSON.stringify(relay.events)
    expect(sent).not.toContain("hunter2")
    expect(sent).toContain("[not synced: .env]")
    expect(sent).not.toContain("sk-abcdefghijklmnop1234")
    expect(sent).not.toContain("not mine")
    expect(relay.events.find((e) => e.type === "statusline")?.data).toEqual({ model: "anthropic/claude", tokens: 15, cost: 0.12 })
  })

  test("AC4: /remote off stops control at once: the link is closed, and nothing a poll in flight brings runs", async () => {
    const r = await turnOn()
    await CloudRemote.disable("ses_1")
    expect(relay.ended()).toBe("off")
    expect(CloudRemote.status("ses_1")).toEqual({ on: false })
    relay.send({ type: "permission", requestID: "per_1", reply: "once" })
    await Bun.sleep(300)
    expect(r.marked).toEqual([])
    expect(await auditLines()).toContainEqual(expect.objectContaining({ event: "remote.off", session: "ses_1", reason: "off" }))
  })

  test("AC4: revoked on the web, or the session deleted, ends it here too", async () => {
    await turnOn()
    relay.revoke()
    await until(() => !CloudRemote.status("ses_1").on)
    expect(await auditLines()).toContainEqual(expect.objectContaining({ event: "remote.off", session: "ses_1", reason: "revoked" }))

    relay.stop()
    relay = fakeRelay()
    await CloudSyncApi.save({ ...(await CloudSyncApi.load())!, endpoint: relay.url })
    await turnOn({ opts: { endpoint: relay.url, token: async () => "t0k" } })
    emit({ type: "session.deleted", properties: { sessionID: "ses_1", info: { id: "ses_1" } } })
    expect(CloudRemote.status("ses_1").on).toBe(false)
    await until(() => relay.ended() === "off")
  })

  test("AC2: the computer only makes outgoing requests: remote-link has no server and imports nothing", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/cloud/remote-link.ts")).text()
    expect(source).not.toMatch(/^import /m)
    expect(source).not.toMatch(/Bun\.serve|createServer|\.listen\(/)
    const bridge = await Bun.file(path.join(import.meta.dir, "../../src/cloud/remote.ts")).text()
    expect(bridge).not.toMatch(/Bun\.serve|createServer|\.listen\(/)
  })
})
