import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { SessionGroups } from "../../src/session/groups"
import { SessionLive } from "../../src/session/live"
import { SessionOverview } from "../../src/session/overview"

afterEach(async () => {
  await fs.rm(SessionGroups.file(), { force: true })
})

describe("SessionGroups (XCOD-205)", () => {
  test("starts empty when nothing is stored", async () => {
    expect(await SessionGroups.read()).toEqual({ version: 1, groups: [], assignments: {} })
  })

  test("create, rename, recolour, collapse and clear the colour", async () => {
    const group = await SessionGroups.create({ name: "  Client A  ", color: "#AABBCC" })
    expect(group.name).toBe("Client A")
    expect(group.color).toBe("#aabbcc")
    expect(group.collapsed).toBe(false)

    const renamed = await SessionGroups.patch(group.id, { name: "Client B", collapsed: true })
    expect(renamed).toMatchObject({ id: group.id, name: "Client B", color: "#aabbcc", collapsed: true })

    const cleared = await SessionGroups.patch(group.id, { color: null })
    expect(cleared.color).toBeUndefined()
    expect((await SessionGroups.read()).groups).toEqual([cleared])
  })

  test("refuses empty names, overlong names and bad colours", async () => {
    await expect(SessionGroups.create({ name: "   " })).rejects.toBeInstanceOf(SessionGroups.InvalidError)
    await expect(SessionGroups.create({ name: "x".repeat(SessionGroups.NAME_MAX + 1) })).rejects.toBeInstanceOf(
      SessionGroups.InvalidError,
    )
    await expect(SessionGroups.create({ name: "ok", color: "red" })).rejects.toBeInstanceOf(SessionGroups.InvalidError)
    expect((await SessionGroups.read()).groups).toEqual([])
  })

  test("unknown groups are reported, not created", async () => {
    await expect(SessionGroups.patch("grp_missing", { name: "x" })).rejects.toBeInstanceOf(SessionGroups.NotFoundError)
    await expect(SessionGroups.remove("grp_missing")).rejects.toBeInstanceOf(SessionGroups.NotFoundError)
    await expect(SessionGroups.move(["ses_1"], "grp_missing")).rejects.toBeInstanceOf(SessionGroups.NotFoundError)
  })

  test("a session is in at most one group; moving takes it out of the old one", async () => {
    const a = await SessionGroups.create({ name: "A" })
    const b = await SessionGroups.create({ name: "B" })
    await SessionGroups.move(["ses_1", "ses_2", "ses_3"], a.id)
    await SessionGroups.move(["ses_2"], b.id)
    expect((await SessionGroups.read()).assignments).toEqual({ ses_1: a.id, ses_2: b.id, ses_3: a.id })

    await SessionGroups.move(["ses_3"], null)
    expect((await SessionGroups.read()).assignments).toEqual({ ses_1: a.id, ses_2: b.id })
  })

  test("deleting a group forgets the group only; its sessions go back to Ungrouped", async () => {
    const a = await SessionGroups.create({ name: "A" })
    const b = await SessionGroups.create({ name: "B" })
    await SessionGroups.move(["ses_1", "ses_2"], a.id)
    await SessionGroups.move(["ses_3"], b.id)

    await SessionGroups.remove(a.id)
    const state = await SessionGroups.read()
    expect(state.groups.map((group) => group.id)).toEqual([b.id])
    expect(state.assignments).toEqual({ ses_3: b.id })
  })

  test("survives a reopen: the file is the only state", async () => {
    const a = await SessionGroups.create({ name: "Persisted", color: "#112233" })
    await SessionGroups.move(["ses_9"], a.id)
    const text = await fs.readFile(SessionGroups.file(), "utf8")
    // Simulate a restart: nothing is cached in memory, so a fresh read sees the same thing.
    await fs.writeFile(SessionGroups.file(), text)
    const state = await SessionGroups.read()
    expect(state.groups).toEqual([a])
    expect(state.assignments).toEqual({ ses_9: a.id })
  })

  test("keeps assignments for sessions this process doesn't know (other channels share the file)", async () => {
    const a = await SessionGroups.create({ name: "A" })
    await SessionGroups.move(["ses_from_another_channel"], a.id)
    await SessionGroups.create({ name: "B" })
    expect((await SessionGroups.read()).assignments).toEqual({ ses_from_another_channel: a.id })
  })

  test("a corrupt file reads as empty instead of failing", async () => {
    await fs.mkdir(SessionGroups.dir(), { recursive: true })
    await fs.writeFile(SessionGroups.file(), "{not json")
    expect(await SessionGroups.read()).toEqual({ version: 1, groups: [], assignments: {} })
  })

  test("concurrent writers don't lose each other's changes", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, index) => SessionGroups.create({ name: `G${index}` })))
    expect((await SessionGroups.read()).groups).toHaveLength(10)
  })

  test("subscribers hear about changes", async () => {
    let calls = 0
    const off = SessionGroups.subscribe(() => calls++)
    await SessionGroups.create({ name: "A" })
    off()
    expect(calls).toBeGreaterThan(0)
  })
})

describe("SessionLive (XCOD-205)", () => {
  afterEach(() => SessionLive.reset())

  test("tracks running sessions and pending approvals across projects", () => {
    SessionLive.handle({
      directory: "/a",
      payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
    })
    SessionLive.handle({
      directory: "/b",
      payload: { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_b" } },
    })
    SessionLive.handle({
      directory: "/b",
      payload: { type: "question.v2.asked", properties: { id: "que_1", sessionID: "ses_b" } },
    })
    expect(SessionLive.get("ses_a")).toEqual({ status: "busy", permissions: 0, questions: 0 })
    expect(SessionLive.get("ses_b")).toEqual({ status: undefined, permissions: 1, questions: 1 })
    expect(SessionLive.active()).toEqual(new Set(["ses_a", "ses_b"]))

    SessionLive.handle({
      directory: "/b",
      payload: { type: "permission.replied", properties: { sessionID: "ses_b", requestID: "per_1" } },
    })
    SessionLive.handle({
      directory: "/a",
      payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } },
    })
    expect(SessionLive.get("ses_a").status).toBeUndefined()
    expect(SessionLive.get("ses_b")).toEqual({ status: undefined, permissions: 0, questions: 1 })
  })

  test("a disposed instance drops its sessions' live state", () => {
    SessionLive.handle({
      directory: "/b",
      payload: { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_b" } },
    })
    SessionLive.handle({
      directory: "/a",
      payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
    })
    SessionLive.handle({
      directory: "/b",
      payload: { type: "server.instance.disposed", properties: { directory: "/b" } },
    })
    expect(SessionLive.get("ses_b").permissions).toBe(0)
    expect(SessionLive.get("ses_a").status).toBe("busy")
    SessionLive.handle({ directory: "global", payload: { type: "global.disposed", properties: {} } })
    expect(SessionLive.active().size).toBe(0)
  })

  test("stopping a waiting session clears its pending approvals (no replied event is sent)", () => {
    SessionLive.handle({
      directory: "/b",
      payload: { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_b" } },
    })
    SessionLive.handle({
      directory: "/b",
      payload: { type: "session.status", properties: { sessionID: "ses_b", status: { type: "idle" } } },
    })
    expect(SessionLive.get("ses_b")).toEqual({ status: undefined, permissions: 0, questions: 0 })
  })
})

describe("SessionOverview.state (XCOD-205)", () => {
  const now = 1_000_000_000
  const idle: SessionLive.Activity = { permissions: 0, questions: 0 }

  test("waiting for an answer wins over running", () => {
    expect(
      SessionOverview.state({ activity: { status: "busy", permissions: 1, questions: 0 }, updated: now, now }),
    ).toEqual({ state: "waiting" })
  })

  test("running in this process", () => {
    expect(
      SessionOverview.state({ activity: { status: "retry", permissions: 0, questions: 0 }, updated: now, now }),
    ).toEqual({ state: "running" })
  })

  test("finished, failed, stopped and never-answered turns", () => {
    const done = { role: "assistant", time: { completed: now } }
    expect(SessionOverview.state({ activity: idle, last: done, updated: now, now }).state).toBe("finished")
    const failed = { role: "assistant", error: { name: "APIError" }, time: {} }
    expect(SessionOverview.state({ activity: idle, last: failed, updated: now, now }).state).toBe("failed")
    const stopped = { role: "assistant", error: { name: "MessageAbortedError" }, time: {} }
    expect(SessionOverview.state({ activity: idle, last: stopped, updated: now, now }).state).toBe("idle")
    expect(SessionOverview.state({ activity: idle, last: { role: "user" }, updated: now, now }).state).toBe("idle")
    expect(SessionOverview.state({ activity: idle, updated: now, now }).state).toBe("idle")
  })

  test("an unfinished turn nobody here is running: recent means another Lunos runs it, old means abandoned", () => {
    const open = { role: "assistant", time: {} }
    expect(SessionOverview.state({ activity: idle, last: open, updated: now - 1000, now })).toEqual({
      state: "running",
      elsewhere: true,
    })
    expect(SessionOverview.state({ activity: idle, last: open, updated: now - 60 * 60 * 1000, now }).state).toBe("idle")
  })

  test("kinds: subagent by parent, scheduled by unattended metadata", () => {
    expect(SessionOverview.kind({ parentID: "ses_p" as never })).toBe("subagent")
    expect(SessionOverview.kind({ metadata: { unattended: true } })).toBe("scheduled")
    expect(SessionOverview.kind({})).toBe("session")
    // XCOD-218: a Claude Code / Codex session run inside Lunos is labelled external, with its tool.
    expect(SessionOverview.kind({ metadata: { external: { tool: "claude", session: "abc" } } })).toBe("external")
    expect(SessionOverview.externalOf({ metadata: { external: { tool: "codex" } } })).toEqual({ tool: "codex" })
    expect(SessionOverview.externalOf({ metadata: { external: { tool: "other" } } })).toBeUndefined()
  })
})
