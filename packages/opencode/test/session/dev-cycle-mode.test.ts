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
import { DevCycle } from "@/session/dev-cycle"

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

describe("dev-cycle output path", () => {
  it.effect("mirrors the plan path under a vcs project", () =>
    Effect.sync(() => {
      const ctx = instance({ vcs: true, worktree: "/tmp/wt" })
      const session = { slug: "my-feature", time: { created: 1700000000000 } }

      expect(SessionNs.devcycle(session, ctx)).toBe(SessionNs.plan(session, ctx).replace("/plans/", "/dev-cycle/"))
      expect(SessionNs.devcycle(session, ctx)).toBe("/tmp/wt/.opencode/dev-cycle/1700000000000-my-feature.md")
    }),
  )

  it.effect("mirrors the plan path outside a vcs project", () =>
    Effect.sync(() => {
      const ctx = instance({ vcs: false, worktree: "/tmp/wt" })
      const session = { slug: "my-feature", time: { created: 1700000000000 } }

      expect(SessionNs.devcycle(session, ctx)).toBe(SessionNs.plan(session, ctx).replace("/plans/", "/dev-cycle/"))
      expect(SessionNs.devcycle(session, ctx)).not.toContain("/tmp/wt")
    }),
  )
})

describe("dev-cycle cursor parsing", () => {
  const frontmatter = (phase: string, gate: string) => `---\nphase: ${phase}\ngate: ${gate}\n---\n\n# Cycle\n`

  it.effect("reads phase and gate from frontmatter", () =>
    Effect.sync(() => {
      expect(DevCycle.parseCursor(frontmatter("architect", "approved"))).toEqual({
        phase: "architect",
        gate: "approved",
      })
      expect(DevCycle.parseCursor(frontmatter("verify", "pending"))).toEqual({ phase: "verify", gate: "pending" })
    }),
  )

  it.effect("degrades to discover/pending rather than throwing", () =>
    Effect.sync(() => {
      // Each of these is a real way the file can be wrong: absent, empty,
      // no frontmatter at all, unterminated block, unknown phase, unknown gate.
      expect(DevCycle.parseCursor(undefined)).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor("")).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor("# Cycle\n\nno frontmatter here")).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor("---\nphase: architect\n")).toEqual(DevCycle.DEFAULT_CURSOR)
      expect(DevCycle.parseCursor(frontmatter("deploy", "approved"))).toEqual({
        phase: "discover",
        gate: "approved",
      })
      expect(DevCycle.parseCursor(frontmatter("plan", "yes"))).toEqual({ phase: "plan", gate: "pending" })
    }),
  )

  it.effect("tolerates windows line endings and surrounding whitespace", () =>
    Effect.sync(() => {
      expect(DevCycle.parseCursor("---\r\nphase:   build  \r\ngate: approved\r\n---\r\n")).toEqual({
        phase: "build",
        gate: "approved",
      })
    }),
  )

  it.effect("reports whether the phase was actually read", () =>
    Effect.sync(() => {
      expect(DevCycle.parseCursorResult(frontmatter("architect", "approved")).ok).toBe(true)
      // No block, no phase line, and an unknown phase are all unreadable.
      expect(DevCycle.parseCursorResult(undefined).ok).toBe(false)
      expect(DevCycle.parseCursorResult("# Cycle\n").ok).toBe(false)
      expect(DevCycle.parseCursorResult("---\ngate: approved\n---\n").ok).toBe(false)
      expect(DevCycle.parseCursorResult(frontmatter("deploy", "approved")).ok).toBe(false)
      // The two strictness traps a human hand-edit falls into.
      expect(DevCycle.parseCursorResult(frontmatter("Architect", "pending")).ok).toBe(false)
      expect(DevCycle.parseCursorResult("---\nphase: architect  # waiting\n---\n").ok).toBe(false)
    }),
  )

  it.effect("treats an unreadable gate as a safe degradation, not a failure", () =>
    Effect.sync(() => {
      // The gate falls back to `pending`, which only ever asks for an approval
      // again. Only a lost *phase* risks redoing finished work.
      const result = DevCycle.parseCursorResult(frontmatter("plan", "yes"))
      expect(result.ok).toBe(true)
      expect(result.cursor).toEqual({ phase: "plan", gate: "pending" })
    }),
  )
})

describe("dev-cycle mode agent", () => {
  it.instance("carries no prompt, so the provider system prompt is retained", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")

      expect(devcycle).toBeDefined()
      expect(devcycle?.mode).toBe("primary")
      // `prompt` replaces SystemPrompt.provider() for primary agents (XCOD-45).
      expect(devcycle?.prompt).toBeUndefined()
    }),
  )

  // Parity with `plan` rather than a literal "allow", for the same reason the
  // research test gives at research-mode.test.ts:100-107: these scalar rules
  // resolve through glob matching whose behaviour on a non-path subject is a
  // quirk `plan` has already shipped with. The invariant that matters is that
  // dev-cycle is never more restricted than plan for the tool its gates need.
  it.instance("allows question at least as freely as plan, since every gate depends on it", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")
      const plan = yield* agents.get("plan")

      expect(Permission.evaluate("question", "", devcycle.permission).action).toBe(
        Permission.evaluate("question", "", plan.permission).action,
      )
    }),
  )

  it.instance("does not deny task, so phases can delegate to subagents", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")
      const plan = yield* agents.get("plan")

      // plan denies task.general; this mode must not.
      expect(Permission.evaluate("task", "general", plan.permission).action).toBe("deny")
      expect(Permission.evaluate("task", "general", devcycle.permission).action).not.toBe("deny")
    }),
  )

  it.instance("can edit the codebase, unlike plan and research", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const devcycle = yield* agents.get("dev-cycle")
      const research = yield* agents.get("research")

      expect(Permission.evaluate("edit", "packages/opencode/src/index.ts", devcycle.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "packages/opencode/src/index.ts", research.permission).action).toBe("deny")
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

// A prior assistant turn, used to put a mode-switch in the history. Only its
// role and `agent` are read (reminders.ts:100).
const assistantMessage = (input: { sessionID: string; agent: string }) => ({
  info: {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "assistant",
    agent: input.agent,
    time: { created: Date.now() },
  } as unknown as SessionV1.Info,
  parts: [] as SessionV1.Part[],
})

const reminderText = (parts: SessionV1.Part[]) =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const applyFor = (agentName: string, seed?: string, options?: { priorAgent?: string }) =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const agents = yield* Agent.Service
    const ctx = yield* InstanceState.context
    const session = yield* sessions.create({})
    const agent = yield* agents.get(agentName)
    const messageID = MessageID.ascending()
    const file = SessionNs.devcycle(session, ctx)

    if (seed !== undefined) yield* Effect.promise(() => Bun.write(file, seed))

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

    const user = userMessage({ sessionID: session.id, messageID })
    // Reminders are pushed onto the last *user* message, so hold the reference
    // rather than indexing — a prior turn shifts index 0.
    const messages = (
      options?.priorAgent ? [assistantMessage({ sessionID: session.id, agent: options.priorAgent }), user] : [user]
    ) as any
    yield* SessionReminders.apply({ messages, agent, session })
    return { session, file, parts: user.parts }
  })

describe("dev-cycle mode reminder", () => {
  it.instance("injects a reminder carrying the resolved artifact path", () =>
    Effect.gen(function* () {
      const { file, parts } = yield* applyFor("dev-cycle")
      const text = reminderText(parts)

      expect(text).toContain("Dev-cycle mode is active")
      expect(text).toContain("No cycle file exists yet")
      expect(text).toContain(file)
      // The placeholder must be interpolated, never emitted literally.
      expect(text).not.toContain("${cycleInfo}")
      // A fresh cycle starts at the first phase with its gate unapproved.
      // Assert the whole interpolated line, not its words: "discover" and
      // "pending" both appear in the static body of dev-cycle-mode.txt (line
      // 10 lists every phase), so a substring assertion would pass even if the
      // cursor were never injected at all.
      expect(text).toContain("Current phase: discover. Gate at the end of this phase: pending.")
      expect(text).toContain("ONLY THE LAST ONE is current")
    }),
  )

  it.instance("injects the cursor parsed from an existing artifact", () =>
    Effect.gen(function* () {
      const { file, parts } = yield* applyFor("dev-cycle", "---\nphase: plan\ngate: approved\n---\n\n# Cycle\n")
      const text = reminderText(parts)

      expect(text).toContain("A cycle file already exists")
      expect(text).toContain(file)
      expect(text).toContain("Current phase: plan. Gate at the end of this phase: approved.")
    }),
  )

  it.instance("degrades to discover/pending on malformed frontmatter", () =>
    Effect.gen(function* () {
      const { parts } = yield* applyFor("dev-cycle", "# Cycle\n\nsomebody deleted the frontmatter\n")
      const text = reminderText(parts)

      expect(text).toContain("Current phase: discover. Gate at the end of this phase: pending.")
      // ...and says so, rather than letting the fallback pass for fact.
      expect(text).toContain("its frontmatter could not be parsed")
    }),
  )

  it.instance("flags an unparseable position instead of presenting it as discover", () =>
    Effect.gen(function* () {
      // `phase: Architect` is the realistic way in: FIELD is case-sensitive,
      // so one capital letter rewinds an in-flight cycle to phase 1. Without
      // the warning this is indistinguishable from genuinely being at
      // discover, and the model restarts discovery over live work.
      const { parts } = yield* applyFor("dev-cycle", "---\nphase: Architect\ngate: approved\n---\n")
      const text = reminderText(parts)

      expect(text).toContain("Current phase: discover. Gate at the end of this phase: approved.")
      expect(text).toContain("Treat this position as unknown")
      expect(text).toContain("do not redo an earlier phase")
    }),
  )

  it.instance("does not cry unknown for a position it could read", () =>
    Effect.gen(function* () {
      // No file at all is not a parse failure — there is nothing to parse.
      const fresh = yield* applyFor("dev-cycle")
      expect(reminderText(fresh.parts)).not.toContain("could not be parsed")

      const good = yield* applyFor("dev-cycle", "---\nphase: build\ngate: approved\n---\n")
      expect(reminderText(good.parts)).toContain("Current phase: build. Gate at the end of this phase: approved.")
      expect(reminderText(good.parts)).not.toContain("could not be parsed")

      // An unreadable gate degrades on its own and must not trip the warning.
      const gate = yield* applyFor("dev-cycle", "---\nphase: build\ngate: yes\n---\n")
      expect(reminderText(gate.parts)).toContain("Current phase: build. Gate at the end of this phase: pending.")
      expect(reminderText(gate.parts)).not.toContain("could not be parsed")
    }),
  )

  // The cursor value `build` and the agent name `build` are different
  // namespaces that now share one module: reminders.ts already branches on
  // input.agent.name === "build" (reminders.ts:61-71). This pins them apart.
  it.instance("does not fire for build mode, even with a phase: build artifact", () =>
    Effect.gen(function* () {
      // The prior assistant-`plan` turn is load-bearing: without it `wasPlan`
      // is false at reminders.ts:100 and BUILD_SWITCH never gets pushed, so
      // the second half of spec §8 — "the BUILD_SWITCH path behaves as
      // before" — would silently never run.
      const { parts } = yield* applyFor("build", "---\nphase: build\ngate: pending\n---\n", { priorAgent: "plan" })
      const text = reminderText(parts)

      expect(text).not.toContain("Dev-cycle mode is active")
      expect(text).toContain("Your operational mode has changed from plan to build.")
    }),
  )

  it.instance("leaves the plan and research reminders untouched", () =>
    Effect.gen(function* () {
      const plan = yield* applyFor("plan")
      expect(reminderText(plan.parts)).toContain("Plan mode")
      expect(reminderText(plan.parts)).not.toContain("Dev-cycle mode is active")

      const research = yield* applyFor("research")
      expect(reminderText(research.parts)).toContain("Research mode is active")
      expect(reminderText(research.parts)).not.toContain("Dev-cycle mode is active")
    }),
  )
})
