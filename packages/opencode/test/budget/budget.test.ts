// XCOD-298: budget accounting, status, periods, estimates and thresholds, against the real database.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
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
import { ProjectGroup } from "@/project/group"
import { Budget } from "@/budget"
import { BudgetPeriod } from "@/budget/period"
import { BudgetEstimate } from "@/budget/estimate"
import { BudgetSpend } from "@/budget/spend"
import { BudgetState } from "@/budget/state"
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

afterEach(async () => {
  Budget.reset()
  await fs.rm(ProjectGroup.file(), { force: true })
  await fs.rm(BudgetState.file(), { force: true })
})

const assistant = (sessionID: string, cost: number, tokens = 1000, created = Date.now()) =>
  ({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID: MessageID.ascending(),
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "m",
    providerID: "local",
    time: { created, completed: created },
  }) as never

describe("Budget (XCOD-298)", () => {
  it.instance("counts sessions in their project, subagents in their parent's, and unknown cost apart", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const parent = yield* sessions.create({ title: "web work" })
      const child = yield* sessions.create({ title: "subagent", parentID: parent.id })
      const other = yield* sessions.create({ title: "elsewhere" })
      const group = yield* Effect.promise(() =>
        ProjectGroup.create({ name: "Axsion web", folders: [parent.directory] }),
      )
      yield* Effect.promise(() => ProjectGroup.move([other.id], "global:/nowhere"))
      yield* sessions.updateMessage(assistant(parent.id, 2))
      yield* sessions.updateMessage(assistant(child.id, 1))
      // A model without a price: tokens, no cost.
      yield* sessions.updateMessage(assistant(child.id, 0))
      yield* sessions.updateMessage(assistant(other.id, 5))

      const turns = yield* BudgetSpend.turns(0)
      const mine = BudgetSpend.total(turns, (turn) => turn.project === group.id)
      expect(mine).toEqual({ spent: 3, unknown: 1 })
      expect(turns.find((turn) => turn.session === child.id)?.subagent).toBe(true)

      // No budget: nothing applies.
      expect(yield* Budget.status({ directory: parent.directory }, {})).toEqual([])

      yield* Effect.promise(() => ProjectGroup.setBudget(group.id, { amount: 10, period: "monthly", per_day: 2 }))
      const [status] = yield* Budget.status(
        { directory: parent.directory },
        { budget: { currency: "USD" } },
        { fresh: true },
      )
      expect(status).toMatchObject({ id: `project:${group.id}`, amount: 10, spent: 3, remaining: 7, unknown: 1 })
      expect(status!.today).toEqual({ spent: 3, cap: 2 })
      // EUR (the default) at the configured rate.
      const [eur] = yield* Budget.status(
        { directory: parent.directory },
        { budget: { usd_rate: 0.5 } },
        { fresh: true },
      )
      expect(eur!.spent).toBe(1.5)
      expect(Budget.left(eur!)).toBe(`€8.50 left of €10.00 (${eur!.period.label})`)

      // The guard: past the daily cap, the default ("ask") becomes "stop" for a session nobody can answer.
      const answerless = yield* sessions.create({
        title: "lunos run",
        permission: [{ permission: "question", action: "deny", pattern: "*" }],
      })
      const decision = yield* Budget.guard({
        session: { id: answerless.id },
        directory: parent.directory,
        config: { budget: { currency: "USD" } },
        start: true,
        turn: { recent: [], context: 0, cached: 0 },
      })
      expect(decision.action).toBe("stop")
      expect(decision.action === "stop" && decision.message).toContain("daily cap")
      // The 50% threshold (3 of 10 is 30%: none yet) — then a step past it alerts once.
      expect(decision.toasts).toEqual([])
      Budget.spent(parent.id, 3)
      const next = yield* Budget.guard({
        session: { id: parent.id },
        directory: parent.directory,
        config: { budget: { currency: "USD", on_limit: "warn" } },
        start: false,
        turn: { recent: [], context: 0, cached: 0 },
      })
      expect(next.toasts).toEqual([expect.stringContaining("used 50% of its")])
      const again = yield* Budget.guard({
        session: { id: parent.id },
        directory: parent.directory,
        config: { budget: { currency: "USD", on_limit: "warn" } },
        start: false,
        turn: { recent: [], context: 0, cached: 0 },
      })
      expect(again.toasts).toEqual([])
    }),
  )
})

describe("accuracy record", () => {
  it.instance("each root turn's estimate is recorded against what the turn cost", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "estimates" })
      const group = yield* Effect.promise(() => ProjectGroup.create({ name: "Est", folders: [session.directory] }))
      yield* Effect.promise(() => ProjectGroup.setBudget(group.id, { amount: 1000 }))
      const guard = (recent: number[]) =>
        Budget.guard({
          session: { id: session.id },
          directory: session.directory,
          config: {},
          start: true,
          price: { input: 3, output: 15 },
          model: "local/m",
          turn: { recent, context: 10_000, cached: 0 },
        })
      yield* guard([0.1, 0.2, 0.3])
      // The next turn starts: the last one cost 0.25.
      yield* guard([0.1, 0.2, 0.3, 0.25])
      const [entry] = yield* Effect.promise(() => BudgetState.accuracy())
      expect(entry).toMatchObject({ session: session.id, model: "local/m", actual: 0.25 })
      expect(entry!.low).toBeLessThanOrEqual(entry!.high)
    }),
  )
})

describe("BudgetPeriod", () => {
  test("monthly from a reset day, weekly from Monday, and total", () => {
    const at = new Date(2026, 9, 22, 12).getTime()
    expect(BudgetPeriod.of({}, at)).toMatchObject({ key: "2026-10", label: "Oct" })
    expect(BudgetPeriod.of({ reset_day: 25 }, at)).toMatchObject({ key: "2026-09-25", label: "25 Sep – 24 Oct" })
    expect(BudgetPeriod.of({ period: "weekly" }, at)).toMatchObject({ key: "w2026-10-19", label: "week of 19 Oct" })
    expect(BudgetPeriod.of({ period: "total" }, at)).toMatchObject({ key: "total", end: Infinity })
    expect(BudgetPeriod.last({}, 6, at).map((period) => period.label)).toEqual([
      "Oct",
      "Sep",
      "Aug",
      "Jul",
      "Jun",
      "May",
    ])
    expect(BudgetPeriod.parse({}, "2026-09")?.key).toBe("2026-09")
    expect(BudgetPeriod.parse({}, "nonsense")).toBeUndefined()
  })
})

describe("BudgetEstimate", () => {
  test("a model without a price has no estimate (unknown cost, never 0)", () => {
    expect(
      BudgetEstimate.estimate({ context: 1000, price: { input: 0, output: 0 }, recent: [1, 2, 3] }),
    ).toBeUndefined()
    expect(BudgetEstimate.unpriced(undefined)).toBe(true)
  })

  test("after 20 turns, the actual cost falls inside the shown range at least 80% of the time on a fixture", () => {
    // A fixed pseudo-random session: turns of $0.05–$0.40, log-normal-ish, as real sessions look.
    let seed = 42
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const turn = () => Math.exp(Math.log(0.12) + (random() + random() + random() - 1.5) * 0.9)
    const history = Array.from({ length: 20 }, turn)
    let hits = 0
    const trials = 200
    for (let i = 0; i < trials; i++) {
      const range = BudgetEstimate.estimate({
        context: 20_000,
        price: { input: 3, output: 15 },
        recent: history,
      })!
      const actual = turn()
      if (BudgetEstimate.hit(range, actual)) hits++
      history.push(actual)
    }
    expect(hits / trials).toBeGreaterThanOrEqual(0.8)
  })

  test("the line shown before a turn", () => {
    const status = {
      remaining: 12.4,
      amount: 50,
      currency: "EUR" as const,
      period: BudgetPeriod.of({}, new Date(2026, 9, 5).getTime()),
      unknown: 0,
    } as Budget.Status
    const line = Budget.line({
      estimate: { low: 0.08 / 0.9, high: 0.3 / 0.9, basis: 20 },
      status,
      settings: Budget.settings({}),
    })
    expect(line).toBe("est. €0.08–0.30 · €12.40 left of €50.00 (Oct)")
  })
})

describe("BudgetState", () => {
  test("each threshold alerts once per period", async () => {
    expect(await BudgetState.claim("project:a", "2026-10", [50])).toEqual([50])
    expect(await BudgetState.claim("project:a", "2026-10", [50, 80])).toEqual([80])
    expect(await BudgetState.claim("project:a", "2026-10", [50, 80])).toEqual([])
    expect(await BudgetState.claim("project:a", "2026-11", [50])).toEqual([50])
  })
})
