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
