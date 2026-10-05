import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect, afterEach } from "bun:test"
import os from "os"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { ConfigPolicy } from "../../src/config/policy"
import { TRUNCATION_DIR } from "../../src/tool/truncation-dir"
import path from "path"
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

// PO decision (2026-10-05): a lock fixes the configured rule, but "always allow" and --auto still
// work in the session. Neither writes to config, so nothing persists past the session (AC4).
it.instance(
  "always allow on a locked permission holds for the session and refuses nothing",
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
        // A user wildcard allow doesn't skip the locked "ask"...
        ruleset: Permission.fromConfig({ "*": "allow" }),
      }

      const first = yield* ask(request).pipe(Effect.forkScoped)
      const [pending] = yield* waitForPending(1)
      yield* reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(first)
      expect(refusals).toEqual([])

      // ...but the user's "always allow" answers it from then on.
      expect(yield* ask(request)).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "always allow can't lift a locked deny",
  () =>
    Effect.gen(function* () {
      ConfigPolicy.activatePermission(["permission.bash"], { permission: { bash: { "*": "ask", "rm *": "deny" } } })
      const first = yield* ask({
        sessionID: session,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["*"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      const [pending] = yield* waitForPending(1)
      yield* reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(first)

      const err = yield* fail(
        ask({ sessionID: session, permission: "bash", patterns: ["rm -rf /"], metadata: {}, always: [], ruleset: [] }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
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

// A lock can't loosen what Lunos itself restricts, and can't block reading truncated tool output.

it.instance(
  "a locked allow doesn't lift an agent's or a session's deny",
  () =>
    Effect.gen(function* () {
      ConfigPolicy.activatePermission(["permission.edit"], { permission: { edit: "allow" } })
      // The plan agent denies edits; the task tool denies tools on subagent sessions.
      const plan = Permission.merge(Permission.fromConfig({ "*": "allow" }), Permission.fromConfig({ edit: "deny" }))
      const err = yield* fail(
        ask({
          sessionID: session,
          permission: "edit",
          patterns: ["src/index.ts"],
          metadata: {},
          always: [],
          ruleset: plan,
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "a locked external_directory still lets the agent read truncated tool output",
  () =>
    Effect.gen(function* () {
      ConfigPolicy.activatePermission(["permission"], { permission: { external_directory: "ask" } })
      // agent.ts appends this allow to every agent.
      const agent = Permission.fromConfig({ external_directory: { [path.join(TRUNCATION_DIR, "*")]: "allow" } })
      const result = yield* ask({
        sessionID: session,
        permission: "external_directory",
        patterns: [path.join(TRUNCATION_DIR, "tool_abc")],
        metadata: {},
        always: [],
        ruleset: agent,
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "a policy that names the truncation directory itself is followed",
  () =>
    Effect.gen(function* () {
      ConfigPolicy.activatePermission(["permission"], {
        permission: { external_directory: { [path.join(TRUNCATION_DIR, "*")]: "deny" } },
      })
      const agent = Permission.fromConfig({ external_directory: { [path.join(TRUNCATION_DIR, "*")]: "allow" } })
      const err = yield* fail(
        ask({
          sessionID: session,
          permission: "external_directory",
          patterns: [path.join(TRUNCATION_DIR, "tool_abc")],
          metadata: {},
          always: [],
          ruleset: agent,
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)
