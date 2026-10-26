import { describe, expect, test } from "bun:test"
import { MemoryStats } from "../../src/memory/stats"
import { MemoryRecall } from "../../src/memory/recall"
import type { MemoryStore } from "../../src/memory/store"

// XCOD-252: the analytics against a fixture ledger and audit log, counted by hand.

const NOW = new Date("2026-10-17T12:00:00Z")
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

function fact(id: string, fields: Partial<MemoryStore.Fact> & { age?: number; source?: string; agent?: string } = {}) {
  const { age = 30, source = "user message", agent = "build", ...rest } = fields
  return {
    id,
    datasetID: "ds",
    text: `fact ${id} text`,
    provenance: { sessionID: "ses_1", agent, source, date: day(age) },
    ...rest,
  } as MemoryStore.Fact
}

const project: MemoryStore.Fact[] = [
  fact("a", { age: 40 }), // active, old, recalled 3x
  fact("b", { age: 40, source: "src/app.ts" }), // active, old, never recalled
  fact("c", { age: 5, source: "bash", kind: "inferred" }), // active, young (not "never recalled")
  fact("d", { age: 50, status: "outdated", invalid_at: day(10), replaced_by: "a" }), // outdated, replaced by a
  fact("e", { age: 60, expires: day(1) }), // expired
  fact("f", { age: 20, expires: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() }), // expiring in 3 days
  fact("q", { age: 30, quarantined: "hash mismatch" }), // quarantined
]
const user: MemoryStore.Fact[] = [
  fact("u1", { age: 100, agent: "plan", imported: { from: "import:old.zip#abc", date: day(100) } }), // imported, never recalled
]

const events = [
  { event: "memory.recall", timestamp: day(1), source: "turn", count: 2, ids: ["a", "c"], truncated: true, chars: 900 },
  { event: "memory.recall", timestamp: day(2), source: "turn", count: 1, ids: ["a"], truncated: false, chars: 300 },
  { event: "memory.recall", timestamp: day(3), source: "tool", count: 1, ids: ["a"] },
  { event: "memory.recall", timestamp: day(3), source: "tui", count: 0, ids: [] },
  { event: "memory.recall", timestamp: day(45), source: "turn", count: 1, ids: ["b"], truncated: false, chars: 100 }, // outside 30d
  { event: "memory.forget", timestamp: day(4), scope: "project", id: "gone" },
  { event: "memory.remember", timestamp: day(5), id: "c" },
]

const base = {
  now: NOW,
  retention: { graceDays: 7 },
  maxTokens: MemoryRecall.DEFAULT_MAX_TOKENS,
  expiringDays: 7,
  scopes: [
    { scope: "project" as const, facts: project, lastWrite: day(5) },
    { scope: "user" as const, facts: user, lastWrite: day(100) },
  ],
}

describe("memory analytics (XCOD-252)", () => {
  const stats = MemoryStats.compute({ ...base, days: 30, events })

  test("per-scope states match a hand count, and size uses chars / 4", () => {
    const p = stats.scopes.find((item) => item.scope === "project")!
    expect(p.counts).toEqual({ active: 4, outdated: 1, expiring: 1, expired: 1, quarantined: 1 })
    const chars = ["a", "b", "c", "f"].reduce((sum, id) => sum + `fact ${id} text`.length, 0)
    expect(p.chars).toBe(chars)
    expect(p.tokens).toBe(Math.ceil(chars / 4))
    expect(stats.scopes.find((item) => item.scope === "user")!.counts.active).toBe(1)
  })

  test("where facts came from", () => {
    expect(stats.sources.source).toEqual({ "user message": 6, file: 1, tool: 1 })
    expect(stats.sources.agent).toEqual({ build: 7, plan: 1 })
    expect(stats.sources.kind).toEqual({ observed: 7, inferred: 1 })
    expect(stats.sources.native).toBe(7)
    expect(stats.sources.imported).toEqual({ "import:old.zip#abc": 1 })
  })

  test("recall figures over the range only, from ids and counts", () => {
    expect(stats.recall.audit).toBe(true)
    expect(stats.recall.total).toBe(4)
    expect(stats.recall.origin).toEqual({ turn: 2, tool: 1, tui: 1 })
    expect(stats.recall.hitRate).toBe(3 / 4)
    expect(stats.recall.avgFacts).toBe(4 / 4)
    expect(stats.recall.truncatedRate).toBe(1 / 2)
    expect(stats.top[0]).toEqual({ id: "a", count: 3, last: day(1) })
    expect(stats.facts.c).toEqual({ recalls: 1, last: day(1) })
    expect(stats.recall.dataSince).toBe(day(45))
  })

  test("never recalled: active facts older than 14 days with no recall in the range, nothing else", () => {
    // b was recalled 45 days ago, outside the range; c is too young; d outdated, q quarantined, e expired.
    expect(stats.groups.never.toSorted()).toEqual(["b", "f", "u1"])
  })

  test("growth per week: added, outdated, forgotten (from the audit log) and expired", () => {
    const sum = (field: "added" | "outdated" | "forgotten" | "expired") =>
      stats.growth.reduce((total, row) => total + row[field], 0)
    expect(sum("added")).toBe(3) // b? no: a/b are 40 days old; c (5), f (20), q (30)
    expect(sum("outdated")).toBe(1)
    expect(sum("forgotten")).toBe(1)
    expect(sum("expired")).toBe(1)
  })

  test("supersession chains, and every count drills down to exactly that many facts", () => {
    expect(stats.supersession).toEqual({ count: 1, chains: [["d", "a"]] })
    const p = stats.scopes.find((item) => item.scope === "project")!
    for (const [state, count] of Object.entries(p.counts)) {
      const key = state === "expiring" ? "expiring:project" : `state:project:${state}`
      expect(stats.groups[key]?.length ?? 0).toBe(count)
    }
    for (const [type, count] of Object.entries(stats.sources.source))
      expect(stats.groups[`source:${type}`].length).toBe(count)
    expect(stats.groups["kind:inferred"]).toEqual(["c"])
    expect(stats.groups["imported:import:old.zip#abc"]).toEqual(["u1"])
  })

  test("with the audit log off there are no recall figures, and no guessing", () => {
    const off = MemoryStats.compute({ ...base, days: 30, events: undefined })
    expect(off.recall).toMatchObject({ audit: false, total: 0, hitRate: null, dataSince: null })
    expect(off.groups.never.toSorted()).toEqual(["a", "b", "f", "u1"])
  })

  test("source types and weeks", () => {
    expect(MemoryStats.sourceType("user message")).toBe("user message")
    expect(MemoryStats.sourceType("docs/README.md")).toBe("file")
    expect(MemoryStats.sourceType("webfetch")).toBe("tool")
    expect(MemoryStats.week(new Date("2026-10-17T12:00:00Z"))).toBe("2026-10-12")
  })

  test("the token cap is recorded: truncated when facts were left out, and the characters injected", () => {
    const recalled = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        fact: { ...fact(`r${i}`), text: "x".repeat(400) } as MemoryStore.Fact,
        score: i,
      }))
    const small = MemoryRecall.blockWithStats([{ scope: "project", facts: recalled(1), graph: "" }], 1500)
    expect(small.truncated).toBe(false)
    expect(small.chars).toBe(small.text!.length)
    const big = MemoryRecall.blockWithStats([{ scope: "project", facts: recalled(40), graph: "" }], 200)
    expect(big.truncated).toBe(true)
  })

  test("10,000 facts and 90 days of audit log compute well within 500 ms", () => {
    const many = Array.from({ length: 10_000 }, (_, i) =>
      fact(`m${i}`, {
        age: i % 200,
        source: i % 3 ? "user message" : "src/x.ts",
        kind: i % 5 ? "observed" : "inferred",
      }),
    )
    const log = Array.from({ length: 90 * 200 }, (_, i) => ({
      event: "memory.recall",
      timestamp: day(i % 90),
      source: i % 2 ? "turn" : "tool",
      count: 3,
      ids: [`m${i % 10_000}`, `m${(i * 7) % 10_000}`, `m${(i * 13) % 10_000}`],
      truncated: i % 4 === 0,
      chars: 1200,
    }))
    const started = performance.now()
    const result = MemoryStats.compute({ ...base, scopes: [{ scope: "project", facts: many }], days: 90, events: log })
    const ms = performance.now() - started
    expect(result.scopes[0].counts.active).toBe(10_000)
    expect(ms).toBeLessThan(500)
  })
})
