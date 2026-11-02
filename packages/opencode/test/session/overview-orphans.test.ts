// XCOD-262: a session whose Lunos closed with prompts queued for it reads "N queued (owner closed)" in
// the overview every rail is built from, and stays listed however old it is, until it's taken over.
import { afterEach, beforeAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AuditLog } from "@/audit/log"
import { SessionLive } from "../../src/session/live"
import { SessionOverview } from "../../src/session/overview"
import { SessionPeers } from "../../src/session/peers"
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

beforeAll(() => AuditLog.activate({ enabled: false, file: "/dev/null", redact: [] }))

afterEach(async () => {
  SessionLive.reset()
  await fs.rm(SessionPeers.dir(), { recursive: true, force: true })
})

/** What a Lunos that quit leaves: its file, closed, with prompts queued for `sessionID`. */
const leftBehind = (sessionID: string, texts: string[]) =>
  Effect.promise(async () => {
    const child = Bun.spawn([process.execPath, "-e", "0"])
    await child.exited
    await fs.mkdir(SessionPeers.dir(), { recursive: true, mode: 0o700 })
    const body: SessionPeers.File = {
      version: 1,
      pid: child.pid,
      heartbeat: Date.now() - 60_000,
      sessions: {},
      queue: { [sessionID]: texts.map((text, index) => ({ id: `qp_${index}`, text })) },
      closed: true,
    }
    await fs.writeFile(path.join(SessionPeers.dir(), `${child.pid}-gone.json`), JSON.stringify(body), { mode: 0o600 })
  })

describe("SessionOverview with a closed Lunos's queued prompts (XCOD-262)", () => {
  it.instance("the row says how many, owner closed; other rows don't", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const held = yield* sessions.create({ title: "held work" })
      const other = yield* sessions.create({ title: "other work" })
      yield* leftBehind(held.id, ["one", "two"])
      const items = (yield* SessionOverview.build()).sessions
      expect(items.find((item) => item.id === held.id)).toMatchObject({ queued: 2, ownerClosed: true })
      const plain = items.find((item) => item.id === other.id)!
      expect(plain.queued).toBeUndefined()
      expect(plain.ownerClosed).toBeUndefined()
      // Counts only: the text stays in the file.
      expect(JSON.stringify(items)).not.toContain('"one"')
    }),
  )

  it.instance("it stays listed past the recent-sessions window until it's taken over", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const held = yield* sessions.create({ title: "held long ago" })
      const old = yield* sessions.create({ title: "just old" })
      yield* leftBehind(held.id, ["one"])
      const later = Date.now() + SessionOverview.WINDOW + 24 * 60 * 60 * 1000
      const ids = (yield* SessionOverview.build({ now: later })).sessions.map((item) => item.id)
      expect(ids).toContain(held.id)
      expect(ids).not.toContain(old.id)
    }),
  )
})
