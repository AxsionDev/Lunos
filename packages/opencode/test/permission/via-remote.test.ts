// XCOD-338: an approval given from app.lunos.tech (remote control) is audited on this computer as
// permission.decision with via: "remote"; one given here has no via.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterAll, beforeAll, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Fiber, Layer } from "effect"
import { AuditLog } from "../../src/audit/log"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

let dir: string
let file: string
const original = AuditLog.current()
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "via-remote-"))
  file = path.join(dir, "audit.log")
  AuditLog.activate({ enabled: true, file, redact: [] })
})
afterAll(async () => {
  await AuditLog.flush()
  AuditLog.activate(original ?? { enabled: false, file: AuditLog.DEFAULT_FILE(), redact: [] })
  await fs.rm(dir, { recursive: true, force: true })
})

const askAndAnswer = (id: string, remote: boolean) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        id: PermissionV1.ID.make(id),
        sessionID: SessionID.make("ses_remote"),
        permission: "bash",
        patterns: ["rm -rf build"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      .pipe(Effect.forkScoped)
    while ((yield* permission.list()).length === 0) yield* Effect.sleep("10 millis")
    if (remote) Permission.markVia(id, "remote")
    yield* permission.reply({ requestID: PermissionV1.ID.make(id), reply: "once" })
    yield* Fiber.join(fiber)
  })

it.instance(
  "a remote approval's decision says via remote; a local one doesn't",
  () =>
    Effect.gen(function* () {
      yield* askAndAnswer("per_remote1", true)
      yield* askAndAnswer("per_local1", false)
      yield* Effect.promise(() => AuditLog.flush())
      const lines = (yield* Effect.promise(() => fs.readFile(file, "utf8")))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.event === "permission.decision" && l.decision === "allowed once")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({ session: "ses_remote", permission: "bash", via: "remote" })
      expect(lines[1].via).toBeUndefined()
    }),
  { git: true },
)
