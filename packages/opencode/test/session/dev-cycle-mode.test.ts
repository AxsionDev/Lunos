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
