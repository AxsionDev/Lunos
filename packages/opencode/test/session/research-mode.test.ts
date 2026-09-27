import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
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
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"

// XCOD-45. Research mode used to be steered by a single `prompt:` on the agent
// definition, which — for a primary agent — *replaces* SystemPrompt.provider()
// (session/llm/request.ts). The mode therefore ran without the provider
// prompt's tool-use discipline and answered straight from memory: a live
// session produced `step-start → reasoning → text → step-finish` with zero
// tool calls. It is now steered like `plan`, by a per-turn reminder.

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

const instance = (input: { vcs: boolean; worktree: string }) =>
  ({
    directory: input.worktree,
    worktree: input.worktree,
    project: { vcs: input.vcs ? "git" : undefined },
  }) as unknown as InstanceContext

describe("research output path", () => {
  // The edit permission in agent/agent.ts is built from the same directory
  // name this helper uses. If they drift, research mode is either allowed to
  // write to a path it is never told about, or told about one it cannot write.
  it.effect("mirrors the plan path under a vcs project", () =>
    Effect.sync(() => {
      const ctx = instance({ vcs: true, worktree: "/tmp/wt" })
      const session = { slug: "my-topic", time: { created: 1700000000000 } }

      expect(SessionNs.research(session, ctx)).toBe(SessionNs.plan(session, ctx).replace("/plans/", "/research/"))
      expect(SessionNs.research(session, ctx)).toBe("/tmp/wt/.opencode/research/1700000000000-my-topic.md")
    }),
  )

  it.effect("mirrors the plan path outside a vcs project", () =>
    Effect.sync(() => {
      const ctx = instance({ vcs: false, worktree: "/tmp/wt" })
      const session = { slug: "my-topic", time: { created: 1700000000000 } }

      expect(SessionNs.research(session, ctx)).toBe(SessionNs.plan(session, ctx).replace("/plans/", "/research/"))
      expect(SessionNs.research(session, ctx)).not.toContain("/tmp/wt")
    }),
  )
})

describe("research mode agent", () => {
  it.instance("carries no prompt, so the provider system prompt is retained", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const research = yield* agents.get("research")
      const plan = yield* agents.get("plan")
      const build = yield* agents.get("build")

      expect(research).toBeDefined()
      // `prompt` replaces SystemPrompt.provider() for primary agents. The two
      // other visible primary modes leave it unset; research must match them.
      expect(plan?.prompt).toBeUndefined()
      expect(build?.prompt).toBeUndefined()
      expect(research?.prompt).toBeUndefined()
    }),
  )

  // The reminder names the path from Session.research(); the agent must be at
  // least as free to write it as `plan` is to write its own. Asserting parity
  // rather than a literal "allow" is deliberate: both modes resolve their
  // allow-rule for the non-vcs case through `path.relative(ctx.worktree, ...)`,
  // which does not match an absolute path when `worktree` is "/" (the value
  // non-git projects get — see project/instance-context.ts). Plan has shipped
  // with that quirk; the invariant that matters here is that research is never
  // *more* restricted than plan.
  it.instance("is no more restricted than plan for its own output file", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const research = yield* agents.get("research")
      const plan = yield* agents.get("plan")
      const ctx = yield* InstanceState.context
      const session = { slug: "topic", time: { created: 1700000000000 } }

      const researchAction = Permission.evaluate("edit", SessionNs.research(session, ctx), research.permission).action
      const planAction = Permission.evaluate("edit", SessionNs.plan(session, ctx), plan.permission).action
      expect(researchAction).toBe(planAction)

      // Inside a vcs project the relative allow-rule is what applies, and it
      // must cover the file the reminder points at.
      expect(Permission.evaluate("edit", ".opencode/research/1700000000000-topic.md", research.permission).action).toBe(
        "allow",
      )
    }),
  )
})

const userMessage = (input: { sessionID: string; messageID: string }) => ({
  info: {
    id: input.messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
  } as unknown as SessionV1.Info,
  parts: [] as SessionV1.Part[],
})

const applyFor = (agentName: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const agents = yield* Agent.Service
    const session = yield* sessions.create({})
    const agent = yield* agents.get(agentName)
    const messageID = MessageID.ascending()

    yield* sessions.updateMessage({
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "user",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as SessionV1.Info)

    const messages = [userMessage({ sessionID: session.id, messageID })] as any
    const result = yield* SessionReminders.apply({ messages, agent, session })
    return { session, parts: result[0].parts }
  })

const reminderText = (parts: SessionV1.Part[]) =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")

describe("research mode reminder", () => {
  it.instance("injects a research reminder carrying the resolved output path", () =>
    Effect.gen(function* () {
      const { session, parts } = yield* applyFor("research")
      const ctx = yield* InstanceState.context
      const text = reminderText(parts)

      expect(text).toContain("Research mode is active")
      // The symptom this whole ticket is about.
      expect(text).toContain("Answering from memory is a violation")
      // A build-shaped request must still yield a document, not an edit.
      expect(text).toContain("If the user asks you to build something")
      // The path must be interpolated, not left as a literal placeholder.
      expect(text).not.toContain("${researchInfo}")
      expect(text).toContain(SessionNs.research(session, ctx))
    }),
  )

  it.instance("does not inject the research reminder for build mode", () =>
    Effect.gen(function* () {
      const { parts } = yield* applyFor("build")
      expect(reminderText(parts)).not.toContain("Research mode is active")
    }),
  )

  it.instance("leaves the plan reminder untouched", () =>
    Effect.gen(function* () {
      const { parts } = yield* applyFor("plan")
      const text = reminderText(parts)

      expect(text).toContain("Plan mode")
      expect(text).not.toContain("Research mode is active")
    }),
  )
})
