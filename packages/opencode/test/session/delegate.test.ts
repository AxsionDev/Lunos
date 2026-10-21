import { describe, expect } from "bun:test"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { SessionReminders } from "@/session/reminders"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { backgroundEnabled } from "@/background/enabled"
import { withBackground } from "../../src/tool/task"

// XCOD-287: subagents on by default for development work. Build is told to split independent parts
// across subagents running in parallel (in the background, now on by default); subagent.delegate:
// false turns the nudge off, and Plan can't reach a subagent that writes.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Agent.node,
      RuntimeFlags.node,
      FSUtil.node,
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

const subagentsOf = Effect.fn("DelegateTest.subagents")(function* () {
  const agents = yield* Agent.Service
  return (yield* agents.list()).filter((item) => item.mode !== "primary")
})

describe("subagent defaults", () => {
  it.effect("background subagents are on unless turned off", () =>
    Effect.sync(() => {
      expect(backgroundEnabled(false, {})).toBe(true)
      expect(backgroundEnabled(false, { subagent: {} })).toBe(true)
      expect(backgroundEnabled(false, { subagent: { background: false } })).toBe(false)
      // The old env flag still turns them on.
      expect(backgroundEnabled(true, { subagent: { background: false } })).toBe(true)
    }),
  )

  it.instance("Build delegates by default, and not when subagent.delegate is false", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const subagents = yield* subagentsOf()
      expect(SessionReminders.delegates({ agent: build, session: {}, config: {}, subagents })).toBe(true)
      expect(
        SessionReminders.delegates({ agent: build, session: {}, config: { subagent: { delegate: false } }, subagents }),
      ).toBe(false)
    }),
  )

  it.instance("only top-level Build sessions get the nudge", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const subagents = yield* subagentsOf()
      const build = yield* agents.get("build")
      // A subagent's own session, even one running as build.
      expect(
        SessionReminders.delegates({
          agent: build,
          session: { parentID: "ses_parent" as never },
          config: {},
          subagents,
        }),
      ).toBe(false)
      for (const name of ["plan", "research", "dev-cycle", "general", "explore"]) {
        const agent = yield* agents.get(name)
        expect(SessionReminders.delegates({ agent, session: {}, config: {}, subagents })).toBe(false)
      }
    }),
  )

  it.instance("no nudge when every subagent is denied to Build", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const subagents = yield* subagentsOf()
      const denied = {
        ...build,
        permission: Permission.merge(build.permission, Permission.fromConfig({ task: { "*": "deny" } })),
      }
      expect(SessionReminders.delegates({ agent: denied, session: {}, config: {}, subagents })).toBe(false)
    }),
  )

  it.effect("the nudge says background when background subagents are on, and waiting when off", () =>
    Effect.sync(() => {
      const on = SessionReminders.delegateReminder(true)
      const off = SessionReminders.delegateReminder(false)
      expect(on).toContain("background: true")
      expect(on).toContain("in parallel")
      expect(off).not.toContain("background: true")
      expect(off).not.toContain("${backgroundInfo}")
    }),
  )

  it.instance("the nudge is added for the request only, never saved", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const agents = yield* Agent.Service
      const session = yield* sessions.create({})
      const build = yield* agents.get("build")
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as never)
      const messages = [
        {
          info: { id: messageID, sessionID: session.id, role: "user", time: { created: Date.now() } },
          parts: [],
        },
      ] as any
      const delegate = SessionReminders.delegateReminder(true)
      const result = yield* SessionReminders.apply({ messages, agent: build, session, delegate })
      const texts = result[0].parts.flatMap((part: any) => (part.type === "text" ? [part.text] : []))
      expect(texts).toEqual([delegate])
      expect(result[0].parts[0]).toMatchObject({ synthetic: true })
      const stored = yield* sessions.messages({ sessionID: session.id })
      expect(stored.flatMap((message) => message.parts)).toEqual([])
    }),
  )

  it.instance("Plan can't reach a subagent that writes or runs commands", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plan = yield* agents.get("plan")
      expect(Permission.evaluate("task", "general", plan.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "qa", plan.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "explore", plan.permission).action).not.toBe("deny")
    }),
  )

  it.effect("the task tool offers background only while background subagents are on", () =>
    Effect.sync(() => {
      const input = {
        description:
          "Launch a new agent.\n\nBackground mode: background=true launches the subagent asynchronously and returns immediately. Foreground is the default; use it when you need the result before continuing. Use background only for independent work that can run while you continue elsewhere. You will be notified automatically when it finishes.",
        schema: {
          type: "object" as const,
          properties: { prompt: { type: "string" as const }, background: { type: "boolean" as const } },
        },
      }
      expect(withBackground(input, true)).toEqual(input)
      const off = withBackground(input, false)
      expect(Object.keys(off.schema.properties ?? {})).toEqual(["prompt"])
      expect(off.description).toBe("Launch a new agent.")
    }),
  )
})
