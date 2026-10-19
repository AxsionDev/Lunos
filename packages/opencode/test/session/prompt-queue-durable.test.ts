// XCOD-262: the Agent Monitor's queued prompts outlive the Lunos that holds them. They are written to
// its 0600 peer file, shown as "N queued (owner closed)" once it stops, and sent (in order) or
// discarded only when another Lunos takes the session over. Delivery is at most once.
// "Another Lunos" is a real child process (for exit and kill), or a file it left behind.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { existsSync, readdirSync, statSync } from "fs"
import path from "path"
import { Audit } from "@opencode-ai/core/audit"
import { Global } from "@opencode-ai/core/global"
import { AuditLog } from "@/audit/log"
import { GlobalBus } from "../../src/bus/global"
import { SessionLive } from "../../src/session/live"
import { SessionPeerControl } from "../../src/session/peer-control"
import { SessionPeers } from "../../src/session/peers"
import { SessionPromptQueue } from "../../src/session/prompt-queue"

let calls: { path: string; body: any }[] = []

// The audit trail is off until a test turns it on, so nothing is held back for a later activation.
beforeAll(() => AuditLog.activate({ enabled: false, file: "/dev/null", redact: [] }))

beforeEach(() => {
  calls = []
  SessionLive.start()
  SessionPeerControl.useHandler(async (request) => {
    const url = new URL(request.url)
    const text = request.method === "POST" ? await request.text() : ""
    calls.push({ path: url.pathname, body: text ? JSON.parse(text) : undefined })
    if (url.pathname === "/question") return Response.json([])
    return Response.json(true)
  })
})

afterEach(async () => {
  SessionPromptQueue.reset()
  SessionPromptQueue.testing.moved = undefined
  SessionLive.reset()
  SessionPeers.reset()
  SessionPeerControl.useHandler(undefined)
  for (const name of await fs.readdir(SessionPeers.dir()).catch(() => [] as string[]))
    await fs.rm(path.join(SessionPeers.dir(), name), { force: true })
})

function status(sessionID: string, type: "busy" | "idle") {
  GlobalBus.emit("event", {
    directory: "/work/a",
    payload: { type: "session.status", properties: { sessionID, status: { type } } },
  })
}

const sent = () => calls.filter((call) => call.path.endsWith("/prompt_async")).map((call) => call.body.parts[0].text)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const ownFile = async () => JSON.parse(await fs.readFile(SessionPeers.own(), "utf8")) as SessionPeers.File
const mode = (file: string) => statSync(file).mode & 0o777
const unix = process.platform !== "win32"

/** A pid that no process has any more: a child that ran and was reaped. */
async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", "0"])
  await child.exited
  return child.pid
}

/** What a Lunos that stopped leaves behind: its file, with prompts queued for `sessionID`. */
async function leftBehind(input: { sessionID: string; texts: string[]; pid?: number; heartbeat?: number }) {
  const pid = input.pid ?? (await deadPid())
  const file = path.join(SessionPeers.dir(), `${pid}-dead.json`)
  await fs.mkdir(SessionPeers.dir(), { recursive: true })
  const body: SessionPeers.File = {
    version: 1,
    pid,
    heartbeat: input.heartbeat ?? Date.now() - 60_000,
    sessions: { [input.sessionID]: { status: "busy", permissions: 0, questions: 0, queued: input.texts.length } },
    queue: { [input.sessionID]: input.texts.map((text, index) => ({ id: `qp_${index + 1}`, text })) },
  }
  await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 })
  return file
}

/** Another Lunos: a child that queues `texts` for a busy session, then exits or waits to be killed. */
async function owner(texts: string[], then: "exit" | "wait") {
  const script = `
    const { Global } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../../core/src/global.ts"))})
    Global.Path.data = ${JSON.stringify(Global.Path.data)}
    const { GlobalBus } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/bus/global.ts"))})
    const { SessionLive } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/live.ts"))})
    const { SessionPeerControl } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/peer-control.ts"))})
    const { SessionPromptQueue } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/prompt-queue.ts"))})
    SessionLive.start()
    SessionPeerControl.useHandler(async () => Response.json(true))
    GlobalBus.emit("event", { directory: "/work/a", payload: { type: "session.status", properties: { sessionID: "ses_owned", status: { type: "busy" } } } })
    for (const text of ${JSON.stringify(texts)}) await SessionPromptQueue.submit({ sessionID: "ses_owned", directory: "/work/a", text })
    console.log("queued")
    ${then === "exit" ? "process.exit(0)" : "setInterval(() => {}, 1000)"}
  `
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" })
  const reader = child.stdout.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toContain("queued")
  return child
}

describe("durable queue (XCOD-262)", () => {
  test("queued prompts are in this process's peer file, in order, before submit returns; the file stays 0600", async () => {
    status("ses_a", "busy")
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "first" })
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "second" })
    // No debounce: the file already has both.
    const body = await ownFile()
    expect(body.queue?.ses_a?.map((entry) => entry.text)).toEqual(["first", "second"])
    expect(body.queue?.ses_a?.every((entry) => /^qp_[a-f0-9]{16}$/.test(entry.id))).toBe(true)
    if (unix) {
      expect(mode(SessionPeers.own())).toBe(0o600)
      expect(mode(SessionPeers.dir())).toBe(0o700)
    }
  })

  test("a prompt leaves the file before it is sent (at most once)", async () => {
    let fileAtSend: string[] | undefined
    SessionPeerControl.useHandler(async (request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/prompt_async"))
        fileAtSend = (await ownFile()).queue?.ses_a?.map((entry) => entry.text) ?? []
      return Response.json(true)
    })
    status("ses_a", "busy")
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "first" })
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "second" })
    status("ses_a", "idle")
    await settle()
    await settle()
    expect(fileAtSend).toEqual(["second"])
  })

  test("a project closing doesn't spend held prompts: they stay in the file", async () => {
    const { disposeInstance } = await import("../../src/effect/instance-registry")
    status("ses_a", "busy")
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "held" })
    // Closing stops the session, which reads as idle: not a turn that ended.
    await disposeInstance("/work/a")
    status("ses_a", "idle")
    await settle()
    expect(sent()).toEqual([])
    expect((await ownFile()).queue?.ses_a?.map((entry) => entry.text)).toEqual(["held"])
  })

  test("a Lunos that exits with prompts queued leaves them in its file, marked closed and still 0600", async () => {
    const child = await owner(["one", "two"], "exit")
    expect(await child.exited).toBe(0)
    const files = readdirSync(SessionPeers.dir()).filter((name) => name.startsWith(`${child.pid}-`))
    expect(files).toHaveLength(1)
    const file = path.join(SessionPeers.dir(), files[0]!)
    const body = JSON.parse(await fs.readFile(file, "utf8")) as SessionPeers.File
    expect(body.closed).toBe(true)
    expect(body.queue?.ses_owned?.map((entry) => entry.text)).toEqual(["one", "two"])
    if (unix) expect(mode(file)).toBe(0o600)
    // Closed means gone at once, whatever the heartbeat: the row reads "2 queued (owner closed)".
    expect(SessionPeers.orphans().get("ses_owned")).toBe(2)
    expect(SessionPeers.read().get("ses_owned")?.fresh ?? false).toBe(false)
  })

  test("closing (the TUI quitting) marks the file closed at once, and a late write doesn't undo it", async () => {
    status("ses_a", "busy")
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "held" })
    SessionPeers.close()
    // A debounced share landing after the close must not make the process look alive again.
    SessionPeers.publish({ ses_a: { status: "busy", permissions: 0, questions: 0 } })
    const body = await ownFile()
    expect(body.closed).toBe(true)
    expect(body.queue?.ses_a?.map((entry) => entry.text)).toEqual(["held"])
    if (unix) expect(mode(SessionPeers.own())).toBe(0o600)
  })

  test("after closing, a turn ending sends nothing: the file is final, so a take-over can't repeat it", async () => {
    status("ses_a", "busy")
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "held" })
    SessionPeers.close()
    status("ses_a", "idle")
    await settle()
    await settle()
    expect(sent()).toEqual([])
    expect((await ownFile()).queue?.ses_a?.map((entry) => entry.text)).toEqual(["held"])
  })

  test("closing with nothing queued removes the file", async () => {
    SessionPeers.publish({ ses_a: { status: "busy", permissions: 0, questions: 0 } })
    expect(existsSync(SessionPeers.own())).toBe(true)
    SessionPeers.close()
    expect(existsSync(SessionPeers.own())).toBe(false)
  })

  test("a Lunos killed with prompts queued: they are counted once its heartbeat is stale, and never forgotten", async () => {
    const child = await owner(["one", "two", "three"], "wait")
    // While it heartbeats, its queue is its own business, not an orphan.
    expect(SessionPeers.orphans().size).toBe(0)
    child.kill("SIGKILL")
    await child.exited
    expect(SessionPeers.orphans({ now: Date.now() + SessionPeers.STALE_MS + 1 }).get("ses_owned")).toBe(3)
    // A day later the file is still there: queued prompts wait for a take-over.
    const later = Date.now() + 24 * 60 * 60 * 1000
    SessionPeers.read({ now: later })
    expect(SessionPeers.orphans({ now: later }).get("ses_owned")).toBe(3)
  })

  test("nothing sends prompts a stopped Lunos queued until the session is taken over", async () => {
    await leftBehind({ sessionID: "ses_a", texts: ["one", "two"] })
    // The session going idle here is not a take-over.
    status("ses_a", "busy")
    status("ses_a", "idle")
    await settle()
    await settle()
    expect(sent()).toEqual([])
    expect(SessionPeers.orphans().get("ses_a")).toBe(2)
  })

  test("take-over sends them in the order they were queued, one per turn, then the new prompt", async () => {
    const file = await leftBehind({ sessionID: "ses_a", texts: ["one", "two"] })
    const result = await SessionPromptQueue.takeover({
      sessionID: "ses_a",
      directory: "/work/a",
      queued: "send",
      text: "three",
    })
    expect(result).toEqual({ sent: 2, discarded: 0, delivery: "queued", position: 2 })
    expect(sent()).toEqual(["one"])
    // They left the old file, which is gone with its last prompt; what's left is held (and filed) here.
    expect(existsSync(file)).toBe(false)
    expect((await ownFile()).queue?.ses_a?.map((entry) => entry.text)).toEqual(["two", "three"])
    if (unix) expect(mode(SessionPeers.own())).toBe(0o600)
    for (const _ of [1, 2]) {
      status("ses_a", "busy")
      status("ses_a", "idle")
      await settle()
    }
    expect(sent()).toEqual(["one", "two", "three"])
    expect(SessionPeers.orphans().size).toBe(0)
  })

  test("take-over of a session already running here queues the new prompt behind the taken ones", async () => {
    await leftBehind({ sessionID: "ses_a", texts: ["one", "two"] })
    status("ses_a", "busy")
    const result = await SessionPromptQueue.takeover({
      sessionID: "ses_a",
      directory: "/work/a",
      queued: "send",
      text: "three",
    })
    // Nothing sent while it runs: all three wait, the new one third.
    expect(result).toEqual({ sent: 2, discarded: 0, delivery: "queued", position: 3 })
    expect(sent()).toEqual([])
    for (const _ of [1, 2, 3]) {
      status("ses_a", "idle")
      await settle()
      status("ses_a", "busy")
    }
    expect(sent()).toEqual(["one", "two", "three"])
  })

  test("take-over can discard them instead: only the new prompt runs", async () => {
    const file = await leftBehind({ sessionID: "ses_a", texts: ["one", "two"] })
    const result = await SessionPromptQueue.takeover({
      sessionID: "ses_a",
      directory: "/work/a",
      queued: "discard",
      text: "fresh",
    })
    expect(result).toEqual({ sent: 0, discarded: 2, delivery: "now" })
    expect(sent()).toEqual(["fresh"])
    expect(existsSync(file)).toBe(false)
    expect(SessionPeers.orphans().size).toBe(0)
  })

  test("take-over only moves that session's prompts; the file keeps the others", async () => {
    const file = await leftBehind({ sessionID: "ses_a", texts: ["a1"] })
    const body = JSON.parse(await fs.readFile(file, "utf8")) as SessionPeers.File
    body.queue!.ses_b = [{ id: "qp_b", text: "b1" }]
    await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 })
    await SessionPromptQueue.takeover({ sessionID: "ses_a", directory: "/work/a", queued: "send" })
    expect(sent()).toEqual(["a1"])
    expect(SessionPeers.orphans()).toEqual(new Map([["ses_b", 1]]))
    if (unix) expect(mode(file)).toBe(0o600)
  })

  test("a crash part-way through a take-over never sends a prompt twice", async () => {
    const file = await leftBehind({ sessionID: "ses_a", texts: ["one", "two", "three"] })
    let moved = 0
    SessionPromptQueue.testing.moved = () => {
      if (++moved === 2) throw new Error("crash")
    }
    await expect(
      SessionPromptQueue.takeover({ sessionID: "ses_a", directory: "/work/a", queued: "send" }),
    ).rejects.toThrow("crash")
    // "one" moved here; "two" left the old file as the crash hit, before it joined this queue: lost,
    // not repeated. "three" never moved and waits for the next take-over.
    expect(SessionPeers.orphans().get("ses_a")).toBe(1)
    expect(JSON.parse(await fs.readFile(file, "utf8")).queue.ses_a.map((entry: any) => entry.text)).toEqual(["three"])
    // The process that crashed is gone, and its file with "one" in it is now an orphan too.
    const crashed = (await ownFile()).queue?.ses_a?.map((entry) => entry.text)
    expect(crashed).toEqual(["one"])
    await fs.writeFile(
      path.join(SessionPeers.dir(), `${await deadPid()}-crashed.json`),
      JSON.stringify({ ...(await ownFile()), pid: await deadPid(), heartbeat: Date.now() - 60_000 }),
      { mode: 0o600 },
    )
    SessionPromptQueue.reset()
    SessionPeers.reset()
    SessionPromptQueue.testing.moved = undefined
    expect(SessionPeers.orphans().get("ses_a")).toBe(2)

    await SessionPromptQueue.takeover({ sessionID: "ses_a", directory: "/work/a", queued: "send" })
    for (const _ of [1, 2]) {
      status("ses_a", "busy")
      status("ses_a", "idle")
      await settle()
    }
    // Each prompt at most once, the oldest file first.
    expect(sent().toSorted()).toEqual(["one", "three"])
    expect(new Set(sent()).size).toBe(sent().length)
    expect(SessionPeers.orphans().size).toBe(0)
  })

  test("refused while the Lunos that queued them still exists (stopped or suspended)", async () => {
    // This test's own pid stands in for a live process whose heartbeat stopped.
    const sleeper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"])
    try {
      await leftBehind({ sessionID: "ses_a", texts: ["one"], pid: sleeper.pid })
      await expect(
        SessionPromptQueue.takeover({ sessionID: "ses_a", directory: "/work/a", queued: "send" }),
      ).rejects.toThrow("still running")
      expect(sent()).toEqual([])
      expect(SessionPeers.orphans().get("ses_a")).toBe(1)
    } finally {
      sleeper.kill("SIGKILL")
      await sleeper.exited
    }
  })

  test("one take-over at a time; a lock left by a crashed taker is taken", async () => {
    const release = SessionPeers.lockTakeover("ses_a")
    // Held by this live process: a second take-over waits its turn.
    const file = path.join(SessionPeers.dir(), "takeover-ses_a.lock")
    await fs.writeFile(file, String(process.ppid))
    expect(() => SessionPeers.lockTakeover("ses_a")).toThrow("taking this session over")
    release()
    await fs.writeFile(file, String(await deadPid()))
    SessionPeers.lockTakeover("ses_a")()
    expect(existsSync(file)).toBe(false)
  })

  test("the text never leaves the file: counts in the claims, counts and ids in the audit", async () => {
    await leftBehind({ sessionID: "ses_a", texts: ["secret prompt", "another secret"] })
    const peer = SessionPeers.read().get("ses_a")
    expect(JSON.stringify(peer)).not.toContain("secret")
    expect(JSON.stringify([...SessionPeers.orphans()])).not.toContain("secret")

    const file = path.join(Global.Path.data, "takeover-audit.log")
    await fs.rm(file, { force: true })
    AuditLog.activate({ enabled: true, file, redact: [] })
    try {
      await SessionPromptQueue.takeover({
        sessionID: "ses_a",
        directory: "/work/a",
        queued: "discard",
        text: "secret too",
      })
      await Audit.flush()
    } finally {
      AuditLog.activate({ enabled: false, file, redact: [] })
    }
    const log = await fs.readFile(file, "utf8")
    await fs.rm(file, { force: true })
    expect(log).not.toContain("secret")
    const lines = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.findLast((line) => line.event === "session.takeover")).toMatchObject({
      session: "ses_a",
      origin: "monitor",
      queued: "discard",
      sent: 0,
      discarded: 2,
      ids: ["qp_1", "qp_2"],
    })
    expect(lines.findLast((line) => line.event === "session.prompt")).toMatchObject({
      session: "ses_a",
      delivery: "now",
    })
  })

  // XCOD-268: Take over on the row has no prompt of its own.
  test("take-over with no new prompt sends just the queued ones, in order", async () => {
    await leftBehind({ sessionID: "ses_a", texts: ["one", "two"] })
    const result = await SessionPromptQueue.takeover({ sessionID: "ses_a", directory: "/work/a", queued: "send" })
    expect(result).toEqual({ sent: 2, discarded: 0 })
    expect(sent()).toEqual(["one"])
    status("ses_a", "busy")
    status("ses_a", "idle")
    await settle()
    status("ses_a", "busy")
    status("ses_a", "idle")
    await settle()
    expect(sent()).toEqual(["one", "two"])
    expect(calls.filter((call) => call.path.endsWith("/prompt_async"))).toHaveLength(2)
    expect(SessionPromptQueue.orphaned("ses_a")).toBe(0)
  })
})

describe("the session view asks first (XCOD-267)", () => {
  test("the count of prompts a closed Lunos holds for a session, never their text", async () => {
    expect(SessionPromptQueue.orphaned("ses_a")).toBe(0)
    await leftBehind({ sessionID: "ses_a", texts: ["one", "two"] })
    expect(SessionPromptQueue.orphaned("ses_a")).toBe(2)
    expect(SessionPromptQueue.orphaned("ses_b")).toBe(0)
  })

  test("the typed prompt runs last, as the exact request the view would have made, without its message id", async () => {
    await leftBehind({ sessionID: "ses_a", texts: ["one", "two"] })
    const body = {
      messageID: "msg_early",
      agent: "plan",
      model: { providerID: "fake", modelID: "fake-1" },
      parts: [
        { type: "text", text: "typed" },
        { type: "file", mime: "text/plain", url: "file:///work/a/x.ts", filename: "x.ts" },
      ],
    }
    const result = await SessionPromptQueue.takeover({
      sessionID: "ses_a",
      directory: "/work/a",
      queued: "send",
      text: "typed",
      agent: "build",
      origin: "session",
      request: { kind: "prompt", body },
    })
    expect(result).toEqual({ sent: 2, discarded: 0, delivery: "queued", position: 2 })
    // The file keeps the readable text only.
    expect((await ownFile()).queue?.ses_a).toEqual([
      expect.objectContaining({ text: "two" }),
      expect.objectContaining({ text: "typed" }),
    ])
    for (const _ of [1, 2]) {
      status("ses_a", "busy")
      status("ses_a", "idle")
      await settle()
    }
    const prompts = calls.filter((call) => call.path.endsWith("/prompt_async"))
    expect(prompts.map((call) => call.body.parts[0].text)).toEqual(["one", "two", "typed"])
    const { messageID: _, ...rest } = body
    expect(prompts[2]!.body).toEqual(rest)
  })

  test("a typed /command or shell command goes to its own route, after the queued ones", async () => {
    for (const [kind, route, body] of [
      ["command", "/session/ses_a/command", { command: "review", arguments: "src", agent: "build" }],
      ["shell", "/session/ses_a/shell", { command: "ls", agent: "build", model: { providerID: "f", modelID: "m" } }],
    ] as const) {
      calls = []
      await leftBehind({ sessionID: "ses_a", texts: ["one"] })
      await SessionPromptQueue.takeover({
        sessionID: "ses_a",
        directory: "/work/a",
        queued: "send",
        text: kind === "command" ? "/review src" : "ls",
        origin: "session",
        request: { kind, body },
      })
      status("ses_a", "busy")
      status("ses_a", "idle")
      await settle()
      expect(calls.filter((call) => call.path.startsWith("/session/")).map((call) => call.path)).toEqual([
        "/session/ses_a/prompt_async",
        route,
      ])
      expect(calls.at(-1)!.body).toEqual(body)
      SessionPromptQueue.reset()
    }
  })

  test("audited once as session.takeover with origin session, counts and ids, never the text", async () => {
    await leftBehind({ sessionID: "ses_a", texts: ["secret one", "secret two"] })
    const file = path.join(Global.Path.data, "takeover-session-audit.log")
    await fs.rm(file, { force: true })
    AuditLog.activate({ enabled: true, file, redact: [] })
    try {
      await SessionPromptQueue.takeover({
        sessionID: "ses_a",
        directory: "/work/a",
        queued: "send",
        text: "secret typed",
        origin: "session",
        request: { kind: "prompt", body: { parts: [{ type: "text", text: "secret typed" }] } },
      })
      await Audit.flush()
    } finally {
      AuditLog.activate({ enabled: false, file, redact: [] })
    }
    const log = await fs.readFile(file, "utf8")
    await fs.rm(file, { force: true })
    expect(log).not.toContain("secret")
    const lines = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.filter((line) => line.event === "session.takeover")).toEqual([
      expect.objectContaining({
        session: "ses_a",
        origin: "session",
        queued: "send",
        sent: 2,
        discarded: 0,
        ids: ["qp_1", "qp_2"],
      }),
    ])
    expect(lines.findLast((line) => line.event === "session.prompt")).toMatchObject({
      session: "ses_a",
      origin: "session",
      delivery: "queued",
    })
  })
})
