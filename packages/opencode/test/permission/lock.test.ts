import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect, afterEach } from "bun:test"
import os from "os"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { ConfigPolicy } from "../../src/config/policy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const rejectAll = (message?: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({
        requestID: req.id,
        reply: "reject",
        message,
      })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })
// XCOD-202: a locked permission holds the managed rule whatever user config, an agent's own
// permission or an "always allow" says. Permission rules match last-wins with wildcards, so the
// lock is applied when the request is evaluated, not only by replacing config keys.

afterEach(() => ConfigPolicy.activatePermission([], {}))

const session = SessionID.make("session_lock")
const lockWebfetch = () => ConfigPolicy.activatePermission(["permission.webfetch"], { permission: { webfetch: "ask" } })

it.instance(
  "a later user wildcard can't allow a locked permission",
  () =>
    Effect.gen(function* () {
      lockWebfetch()
      const user = Permission.fromConfig({ webfetch: "ask", "*": "allow" })
      const fiber = yield* ask({
        sessionID: session,
        permission: "webfetch",
        patterns: ["https://example.com"],
        metadata: {},
        always: ["*"],
        ruleset: user,
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "an agent's own permission can't allow a locked permission",
  () =>
    Effect.gen(function* () {
      lockWebfetch()
      const agent = Permission.merge(
        Permission.fromConfig({ webfetch: "ask" }),
        Permission.fromConfig({ "*": "allow" }),
      )
      const fiber = yield* ask({
        sessionID: session,
        permission: "webfetch",
        patterns: ["https://example.com"],
        metadata: {},
        always: ["*"],
        ruleset: agent,
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "a lock on one permission leaves the others alone",
  () =>
    Effect.gen(function* () {
      lockWebfetch()
      const result = yield* ask({
        sessionID: session,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: Permission.fromConfig({ "*": "allow" }),
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "always allow on a locked permission counts once and is refused",
  () =>
    Effect.gen(function* () {
      lockWebfetch()
      const refusals: ConfigPolicy.Refusal[] = []
      const off = ConfigPolicy.onRefused((refusal) => refusals.push(refusal))
      yield* Effect.addFinalizer(() => Effect.sync(() => off()))
      const request = {
        sessionID: session,
        permission: "webfetch",
        patterns: ["https://example.com"],
        metadata: {},
        always: ["*"],
        ruleset: Permission.fromConfig({ webfetch: "ask" }),
      }

      const first = yield* ask(request).pipe(Effect.forkScoped)
      const [pending] = yield* waitForPending(1)
      yield* reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(first)
      expect(refusals.map((item) => item.key)).toEqual(["permission.webfetch"])

      // Asked again: the "always" didn't stick.
      const second = yield* ask(request).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(second)
    }),
  { git: true },
)

it.instance(
  "a lock on all permissions covers tools managed config doesn't list, for always allow",
  () =>
    Effect.gen(function* () {
      ConfigPolicy.activatePermission(["permission"], { permission: { webfetch: "ask" } })
      expect(ConfigPolicy.isPermissionLocked("bash")).toBe(true)
      expect(ConfigPolicy.permissionKey("bash")).toBe("permission")
      const first = yield* ask({
        sessionID: session,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: Permission.fromConfig({ bash: "ask" }),
      }).pipe(Effect.forkScoped)
      const [pending] = yield* waitForPending(1)
      yield* reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(first)
      const second = yield* ask({
        sessionID: session,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: Permission.fromConfig({ bash: "ask" }),
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(second)
    }),
  { git: true },
)

it.instance(
  "the managed string shorthand locks every permission's rule",
  () =>
    Effect.gen(function* () {
      ConfigPolicy.activatePermission(["permission"], { permission: "deny" })
      const err = yield* fail(
        ask({
          sessionID: session,
          permission: "read",
          patterns: ["README.md"],
          metadata: {},
          always: [],
          ruleset: Permission.fromConfig({ read: "allow" }),
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

test("permission keys are known lock keys", () => {
  expect(
    ConfigPolicy.unknownKeys(["permission", "permission.webfetch", "permission.bash", "permission.a.b", "nope"]),
  ).toEqual(["permission.a.b", "nope"])
})
