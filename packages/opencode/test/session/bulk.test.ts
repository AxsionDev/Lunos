// XCOD-265: Stop all, Clear list (archive), Undo/Unarchive and Delete archived, on the server side.
import { afterEach, beforeAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Audit } from "@opencode-ai/core/audit"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AuditLog } from "@/audit/log"
import { SessionBulk } from "../../src/session/bulk"
import { SessionLive } from "../../src/session/live"
import { SessionOverview } from "../../src/session/overview"
import { SessionPeers } from "../../src/session/peers"
import { ExternalRegistry } from "../../src/external/registry"
import { MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const listed = Effect.fn(function* () {
  return (yield* SessionOverview.build()).sessions.map((item) => item.id)
})
const archivedList = Effect.fn(function* () {
  return (yield* SessionOverview.build({ archived: true })).sessions.map((item) => item.id)
})

const external = (input: Partial<ExternalRegistry.Entry> & { sessionID: string }): ExternalRegistry.Entry => ({
  tool: "claude",
  cwd: "/work/api",
  started: new Date().toISOString(),
  updated: new Date().toISOString(),
  status: "done",
  ...input,
})

// The audit trail is off until a test turns it on, so nothing is held back for a later activation.
beforeAll(() => AuditLog.activate({ enabled: false, file: "/dev/null", redact: [] }))

afterEach(async () => {
  SessionLive.reset()
  await fs.rm(path.join(path.dirname(SessionPeers.dir()), "external"), { recursive: true, force: true })
  await fs.rm(SessionPeers.dir(), { recursive: true, force: true })
})

describe("SessionBulk (XCOD-265)", () => {
  it.instance("Clear archives: the session leaves every list but it and its history stay on disk", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "finished work" })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test" as never, modelID: "test" as never },
        time: { created: Date.now() },
      } as never)

      const result = yield* SessionBulk.archive({ sessionIDs: [session.id] })
      expect(result).toEqual({ archived: [session.id], skipped: [] })
      expect(yield* listed()).not.toContain(session.id)
      expect((yield* sessions.listGlobal()).map((item) => item.id)).not.toContain(session.id)
      expect(yield* archivedList()).toContain(session.id)
      // Nothing deleted: the session and its messages are still there.
      expect((yield* sessions.get(session.id)).time.archived).toBeNumber()
      expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(1)
    }),
  )

  it.instance("Undo / Unarchive puts it back (the archived column really clears)", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "back again" })
      yield* SessionBulk.archive({ sessionIDs: [session.id] })
      expect(yield* SessionBulk.unarchive({ sessionIDs: [session.id] })).toEqual({
        archived: [session.id],
        skipped: [],
      })
      expect((yield* sessions.get(session.id)).time.archived).toBeUndefined()
      expect((yield* sessions.listGlobal()).map((item) => item.id)).toContain(session.id)
      expect(yield* listed()).toContain(session.id)
      expect(yield* archivedList()).not.toContain(session.id)
    }),
  )

  it.instance("subagents are archived and restored with their parent, so no orphan rows are left", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({ title: "child", parentID: parent.id })
      const grandchild = yield* sessions.create({ title: "grandchild", parentID: child.id })
      yield* SessionBulk.archive({ sessionIDs: [parent.id] })
      for (const id of [parent.id, child.id, grandchild.id])
        expect((yield* sessions.get(id)).time.archived).toBeNumber()
      expect(yield* listed()).not.toContain(child.id)
      yield* SessionBulk.unarchive({ sessionIDs: [parent.id] })
      for (const id of [parent.id, child.id, grandchild.id])
        expect((yield* sessions.get(id)).time.archived).toBeUndefined()
    }),
  )

  it.instance("a running or waiting session is never archived, unless the same request just stopped it", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const running = yield* sessions.create({ title: "running" })
      const waiting = yield* sessions.create({ title: "waiting" })
      const done = yield* sessions.create({ title: "done" })
      SessionLive.handle({
        directory: "/work",
        payload: { type: "session.status", properties: { sessionID: running.id, status: { type: "busy" } } },
      })
      SessionLive.handle({
        directory: "/work",
        payload: { type: "permission.asked", properties: { id: "per_1", sessionID: waiting.id } },
      })
      const result = yield* SessionBulk.archive({ sessionIDs: [running.id, waiting.id, done.id] })
      expect(result.archived).toEqual([done.id])
      expect(result.skipped.map((item) => item.id)).toEqual([running.id, waiting.id])
      expect(result.skipped[0]?.reason).toContain("stop it first")

      const forced = yield* SessionBulk.archive({ sessionIDs: [running.id], stopped: [running.id] })
      expect(forced.archived).toEqual([running.id])
    }),
  )

  it.instance("Delete archived removes only archived sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const kept = yield* sessions.create({ title: "still listed" })
      const gone = yield* sessions.create({ title: "archived" })
      yield* SessionBulk.archive({ sessionIDs: [gone.id] })
      const result = yield* SessionBulk.removeArchived({ sessionIDs: [kept.id, gone.id] })
      expect(result.deleted).toEqual([gone.id])
      expect(result.skipped).toEqual([{ id: kept.id, reason: "it isn't archived" }])
      expect(yield* sessions.get(kept.id)).toMatchObject({ id: kept.id })
      expect(yield* sessions.get(gone.id).pipe(Effect.flip)).toBeDefined()
    }),
  )

  it.instance(
    "a Claude Code / Codex row is archived through its registry entry, and deleting it keeps the tool's transcript",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => ExternalRegistry.save(external({ sessionID: "tool-1" })))
        expect(yield* listed()).toContain("external:tool-1")
        expect((yield* SessionBulk.archive({ sessionIDs: ["external:tool-1"] })).archived).toEqual(["external:tool-1"])
        expect(yield* listed()).not.toContain("external:tool-1")
        expect(yield* archivedList()).toEqual(["external:tool-1"])
        expect((yield* SessionBulk.unarchive({ sessionIDs: ["external:tool-1"] })).archived).toEqual([
          "external:tool-1",
        ])
        expect(yield* listed()).toContain("external:tool-1")

        yield* SessionBulk.archive({ sessionIDs: ["external:tool-1"] })
        expect((yield* SessionBulk.removeArchived({ sessionIDs: ["external:tool-1"] })).deleted).toEqual([
          "external:tool-1",
        ])
        expect(yield* Effect.promise(() => ExternalRegistry.get("tool-1"))).toBeUndefined()
      }),
  )

  it.instance("Stop all stops a running external tool, and reports a Lunos that doesn't answer", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const tool = Bun.spawn(["sleep", "30"])
      yield* Effect.promise(() =>
        ExternalRegistry.save(external({ sessionID: "tool-run", status: "running", pid: tool.pid })),
      )
      // Another Lunos claims a session but its control port answers nothing.
      const elsewhere = yield* sessions.create({ title: "in another window" })
      yield* Effect.promise(async () => {
        await fs.mkdir(SessionPeers.dir(), { recursive: true, mode: 0o700 })
        await Bun.write(
          path.join(SessionPeers.dir(), "999999-deadbeef.json"),
          JSON.stringify({
            version: 1,
            pid: 999999,
            heartbeat: Date.now(),
            sessions: { [elsewhere.id]: { status: "busy", permissions: 0, questions: 0, directory: "/work/b" } },
            control: { port: 9, token: "a".repeat(64) },
          }),
        )
      })
      const finished = yield* sessions.create({ title: "already finished" })

      const result = yield* SessionBulk.stop({ sessionIDs: ["external:tool-run", elsewhere.id, finished.id] })
      expect(result.stopped).toEqual(["external:tool-run"])
      expect(result.failed).toEqual([
        { id: elsewhere.id, reason: "another Lunos didn't respond" },
        { id: finished.id, reason: "it isn't running" },
      ])
      expect(yield* Effect.promise(() => tool.exited)).not.toBe(0)
      expect((yield* Effect.promise(() => ExternalRegistry.get("tool-run")))?.status).toBe("stopped")
    }),
  )

  it.instance("Stop all & clear archives what it stopped and what wasn't running, not what failed to stop", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const tool = Bun.spawn(["sleep", "30"])
      yield* Effect.promise(() =>
        ExternalRegistry.save(external({ sessionID: "tool-run", status: "running", pid: tool.pid })),
      )
      const finished = yield* sessions.create({ title: "already finished" })
      const result = yield* SessionBulk.stopAndArchive({ sessionIDs: ["external:tool-run", finished.id] })
      expect(result.stopped).toEqual(["external:tool-run"])
      expect(result.archived.toSorted()).toEqual(["external:tool-run", finished.id].toSorted())
      expect(yield* listed()).not.toContain(finished.id)
      yield* Effect.promise(() => tool.exited)
    }),
  )

  it.instance("archive --finished --older-than picks only old sessions that aren't running", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const old = yield* sessions.create({ title: "old" })
      const busy = yield* sessions.create({ title: "busy" })
      SessionLive.handle({
        directory: "/work",
        payload: { type: "session.status", properties: { sessionID: busy.id, status: { type: "busy" } } },
      })
      const ids = yield* SessionBulk.finished({ before: Date.now() + 1000 })
      expect(ids).toContain(old.id)
      expect(ids).not.toContain(busy.id)
      expect(yield* SessionBulk.finished({ before: Date.now() - 60_000 })).not.toContain(old.id)
    }),
  )

  it.instance("bulk actions are audited with origin bulk, a count and the ids", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const file = path.join(path.dirname(SessionPeers.dir()), `audit-${Date.now()}.log`)
      AuditLog.activate({ enabled: true, file, redact: [] })
      const one = yield* sessions.create({ title: "one" })
      const two = yield* sessions.create({ title: "two" })
      yield* SessionBulk.archive({ sessionIDs: [one.id, two.id] })
      yield* SessionBulk.stop({ sessionIDs: [one.id] })
      yield* Effect.promise(() => Audit.flush())
      const lines = (yield* Effect.promise(() => fs.readFile(file, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      AuditLog.activate({ enabled: false, file, redact: [] })
      expect(lines.find((line) => line.event === "session.archive")).toMatchObject({
        origin: "bulk",
        action: "archive",
        count: 2,
        ids: [one.id, two.id],
      })
      expect(lines.find((line) => line.event === "session.stop")).toMatchObject({ origin: "bulk", count: 0 })
    }),
  )
})
