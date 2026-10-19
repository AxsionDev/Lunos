import { describe, expect, test } from "bun:test"
import type { MemoryStats } from "@opencode-ai/sdk/v2"
import { activityRows, idsFor, overviewRows, sparkline } from "../../src/util/memory-stats"

const stats = {
  version: 1,
  generatedAt: "2026-10-17T12:00:00.000Z",
  rangeDays: 30,
  since: "2026-09-17T12:00:00.000Z",
  status: {
    on: true,
    reason: null,
    backend: { type: "embedded", host: null, jurisdiction: null },
    encryption: "os-keychain",
    retentionDays: null,
    graceDays: 7,
    health: [{ scope: "project", facts: 3, problems: 0, unsealed: 0, encrypted: 2, error: null }],
  },
  scopes: [
    {
      scope: "project",
      counts: { active: 2, outdated: 1, expiring: 0, expired: 0, quarantined: 0 },
      lastWrite: "2026-10-01T10:00:00.000Z",
      error: null,
      chars: 80,
      tokens: 20,
    },
    {
      scope: "user",
      counts: { active: 0, outdated: 0, expiring: 0, expired: 0, quarantined: 0 },
      lastWrite: null,
      error: "can't reach neo4j",
      chars: 0,
      tokens: 0,
    },
  ],
  maxTokens: 1500,
  sources: {
    source: { "user message": 2, file: 1 },
    agent: { build: 3 },
    kind: { observed: 3 },
    native: 3,
    imported: {},
  },
  growth: [{ week: "2026-10-12", scope: "project", added: 1, outdated: 1, forgotten: 0, expired: 0 }],
  recall: {
    audit: true,
    dataSince: "2026-10-01T00:00:00.000Z",
    total: 2,
    perDay: [
      { day: "2026-10-15", count: 1 },
      { day: "2026-10-16", count: 3 },
    ],
    origin: { turn: 2 },
    hitRate: 0.5,
    avgFacts: 1,
    truncatedRate: 0,
  },
  top: [{ id: "a", count: 2, last: "2026-10-16T00:00:00.000Z" }],
  supersession: { count: 1, chains: [["c", "a"]] },
  facts: { a: { recalls: 2, last: "2026-10-16T00:00:00.000Z" } },
  groups: {
    "state:project:active": ["a", "b"],
    "state:project:outdated": ["c"],
    never: ["b"],
    supersession: ["c"],
    "source:user message": ["a", "c"],
    "source:file": ["b"],
    "agent:build": ["a", "b", "c"],
    "kind:observed": ["a", "b", "c"],
    native: ["a", "b", "c"],
  },
} as unknown as MemoryStats

describe("/memory analytics rows (XCOD-252)", () => {
  test("Overview: status, per-scope counts with their drill-down keys, an unreadable scope, health", () => {
    const rows = overviewRows(stats)
    expect(rows[0]!.title).toBe("Memory: on · on this computer · encrypted · kept until removed")
    // XCOD-264: the same "what leaves the computer" sentence as setup and lunos memory status.
    expect(rows[1]!.title).toStartWith("Leaves the computer: the fact text, sent to your model")
    expect(rows.find((row) => row.title === "Active")).toMatchObject({ footer: "2", group: "state:project:active" })
    expect(rows.some((row) => row.title === "can't be read: can't reach neo4j")).toBe(true)
    expect(rows.some((row) => row.title.includes("1 unencrypted line(s) in project memory"))).toBe(true)
  })

  test("Activity: recall since, top recalled by text, never recalled and supersession drill down", () => {
    const rows = activityRows(stats, (id) => (id === "a" ? "The billing service owns invoices." : undefined))
    // The audit log starts after the range does, so the view says how far back it really goes.
    expect(rows.some((row) => row.title === "Recall data since 2026-10-01")).toBe(true)
    expect(rows.find((row) => row.group === "fact:a")).toMatchObject({
      title: "The billing service owns invoices.",
      footer: "2×",
    })
    expect(rows.find((row) => row.group === "never")!.footer).toBe("1")
    expect(rows.find((row) => row.group === "supersession")!.footer).toBe("1")
  })

  test("every count drills down to exactly that many facts", () => {
    for (const row of [...overviewRows(stats), ...activityRows(stats, () => undefined)])
      if (row.group && row.footer && /^\d+$/.test(row.footer))
        expect(idsFor(stats, row.group).length).toBe(Number(row.footer))
    expect(idsFor(stats, "fact:a")).toEqual(["a"])
  })

  test("with the audit log off, Activity says so instead of showing zeros", () => {
    const off = { ...stats, recall: { ...stats.recall, audit: false } } as MemoryStats
    expect(activityRows(off, () => undefined).some((row) => row.value === "recall:off")).toBe(true)
    expect(activityRows(off, () => undefined).some((row) => row.group === "never")).toBe(false)
  })

  test("sparkline", () => {
    expect(sparkline([0, 0])).toBe("▁▁")
    expect(sparkline([1, 4, 8])).toBe("▂▅█")
  })
})
