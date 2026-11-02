export * as MemoryStats from "./stats"

import { MemoryLifecycle } from "./lifecycle"
import type { MemoryStore } from "./store"

// XCOD-252: /memory's Analytics, `lunos memory stats` and GET /memory/stats. Everything is computed
// here, locally, from the provenance ledger and the local audit log: what is in memory, where it
// came from, how it grows and which facts are recalled. The audit log holds ids and counts only
// (never a query or a fact's text), so nothing new is collected to compute this.

export const VERSION = 1
/** Active facts this old with no recall in the range are listed as never recalled. */
export const NEVER_RECALLED_DAYS = 14
/** Chars per token, the same rule as recall's budget (`recall.ts`). */
export const CHARS_PER_TOKEN = 4

export type Counts = { active: number; outdated: number; expiring: number; expired: number; quarantined: number }

export interface ScopeInput {
  scope: MemoryStore.Scope
  facts: MemoryStore.Fact[]
  lastWrite?: string
  error?: string
}

export interface Input {
  now: Date
  /** Undefined: everything the audit log has. */
  days?: number
  scopes: ScopeInput[]
  retention: MemoryLifecycle.Retention
  maxTokens: number
  /** Parsed audit log lines; undefined when the audit log is off. */
  events?: readonly Record<string, unknown>[]
  expiringDays: number
}

export interface Stats {
  version: number
  generatedAt: string
  rangeDays: number | null
  since: string | null
  scopes: {
    scope: string
    counts: Counts
    lastWrite: string | null
    error: string | null
    chars: number
    tokens: number
  }[]
  maxTokens: number
  sources: {
    source: Record<string, number>
    agent: Record<string, number>
    kind: Record<string, number>
    native: number
    imported: Record<string, number>
  }
  growth: { week: string; scope: string; added: number; outdated: number; forgotten: number; expired: number }[]
  recall: {
    audit: boolean
    /** The oldest audit entry: recall statistics exist only from then on. */
    dataSince: string | null
    total: number
    perDay: { day: string; count: number }[]
    origin: Record<string, number>
    hitRate: number | null
    avgFacts: number | null
    /** Share of turn recalls the token cap cut, among those that record it. */
    truncatedRate: number | null
  }
  top: { id: string; count: number; last: string }[]
  supersession: { count: number; chains: string[][] }
  /** Per fact with at least one recall in the range. */
  facts: Record<string, { recalls: number; last: string }>
  /** The fact ids behind each count, for drill-down: `state:<scope>:<state>`, `source:<type>`, … */
  groups: Record<string, string[]>
}

const DAY = 86_400_000

/** "user message", a worktree-relative file, or a tool name. */
export function sourceType(source: string) {
  if (source === "user message") return "user message"
  if (/[\\/]/.test(source) || /\.[A-Za-z0-9]{1,8}$/.test(source)) return "file"
  return "tool"
}

/** Monday of the date's week, as YYYY-MM-DD (UTC). */
export function week(date: Date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

function bump(record: Record<string, number>, key: string, by = 1) {
  record[key] = (record[key] ?? 0) + by
}

function push(groups: Record<string, string[]>, key: string, id: string) {
  ;(groups[key] ??= []).push(id)
}

function time(value: unknown) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? undefined : ms
}

export function compute(input: Input): Stats {
  const now = input.now.getTime()
  const since = input.days ? now - input.days * DAY : undefined
  const inRange = (ms: number | undefined) => ms !== undefined && (since === undefined || ms >= since) && ms <= now
  const groups: Record<string, string[]> = {}
  const sources: Stats["sources"] = { source: {}, agent: {}, kind: {}, native: 0, imported: {} }
  const growth = new Map<string, Stats["growth"][number]>()
  const grow = (ms: number, scope: string, field: "added" | "outdated" | "forgotten" | "expired") => {
    const key = `${week(new Date(ms))}\n${scope}`
    const row = growth.get(key) ?? { week: week(new Date(ms)), scope, added: 0, outdated: 0, forgotten: 0, expired: 0 }
    row[field]++
    growth.set(key, row)
  }

  // Recalls first: "never recalled" and each fact's detail need them.
  const recalls = (input.events ?? []).filter(
    (event) => event.event === "memory.recall" && inRange(time(event.timestamp)),
  )
  const facts: Stats["facts"] = {}
  const perDay: Record<string, number> = {}
  const origin: Record<string, number> = {}
  let hits = 0
  let returned = 0
  let truncatable = 0
  let truncated = 0
  for (const event of recalls) {
    const at = event.timestamp as string
    bump(perDay, at.slice(0, 10))
    bump(origin, typeof event.source === "string" ? event.source : "tool")
    const count = typeof event.count === "number" ? event.count : 0
    returned += count
    if (count > 0) hits++
    if (typeof event.truncated === "boolean") {
      truncatable++
      if (event.truncated) truncated++
    }
    for (const id of Array.isArray(event.ids) ? event.ids : []) {
      if (typeof id !== "string") continue
      const entry = (facts[id] ??= { recalls: 0, last: at })
      entry.recalls++
      if (at > entry.last) entry.last = at
    }
  }

  const scopes: Stats["scopes"] = []
  const byID = new Map<string, MemoryStore.Fact>()
  for (const item of input.scopes) {
    const counts: Counts = { active: 0, outdated: 0, expiring: 0, expired: 0, quarantined: 0 }
    let chars = 0
    for (const fact of item.facts) {
      byID.set(fact.id, fact)
      const state = MemoryLifecycle.state(fact, input.retention, input.now)
      const bucket = state === "purge" ? "expired" : state
      counts[bucket]++
      push(groups, `state:${item.scope}:${bucket}`, fact.id)
      if (bucket === "quarantined") push(groups, "quarantined", fact.id)
      if (bucket === "active") {
        chars += fact.text.length
        const expires = MemoryLifecycle.expiresAt(fact, input.retention)?.getTime()
        if (expires !== undefined && expires - now <= input.expiringDays * DAY) {
          counts.expiring++
          push(groups, `expiring:${item.scope}`, fact.id)
        }
        const age = now - (time(fact.provenance.date) ?? now)
        if (age >= NEVER_RECALLED_DAYS * DAY && !facts[fact.id]) push(groups, "never", fact.id)
      }
      // Where it came from: every stored fact, whatever its state.
      const type = sourceType(fact.provenance.source)
      bump(sources.source, type)
      push(groups, `source:${type}`, fact.id)
      bump(sources.agent, fact.provenance.agent)
      push(groups, `agent:${fact.provenance.agent}`, fact.id)
      const kind = fact.kind ?? "observed"
      bump(sources.kind, kind)
      push(groups, `kind:${kind}`, fact.id)
      if (fact.imported) {
        bump(sources.imported, fact.imported.from)
        push(groups, `imported:${fact.imported.from}`, fact.id)
      } else {
        sources.native++
        push(groups, "native", fact.id)
      }
      // Growth, from the ledger's own dates.
      const added = time(fact.provenance.date)
      if (inRange(added)) grow(added!, item.scope, "added")
      const outdated = time(fact.invalid_at)
      if (inRange(outdated)) grow(outdated!, item.scope, "outdated")
      const expired = MemoryLifecycle.expiresAt(fact, input.retention)?.getTime()
      if (inRange(expired)) grow(expired!, item.scope, "expired")
      if (fact.replaced_by) push(groups, "supersession", fact.id)
    }
    scopes.push({
      scope: item.scope,
      counts,
      lastWrite: item.lastWrite ?? null,
      error: item.error ?? null,
      chars,
      tokens: Math.ceil(chars / CHARS_PER_TOKEN),
    })
  }
  // Forgotten facts are gone from the ledger; the audit log is the only record of them.
  for (const event of input.events ?? []) {
    if (event.event !== "memory.forget") continue
    const at = time(event.timestamp)
    if (inRange(at)) grow(at!, typeof event.scope === "string" ? event.scope : "project", "forgotten")
  }

  // Supersession chains, oldest first: a fact that replaced nothing still in the ledger starts one.
  const chains: string[][] = []
  for (const fact of byID.values()) {
    if (!fact.replaced_by || (fact.replaces && byID.has(fact.replaces))) continue
    const chain = [fact.id]
    let next = fact.replaced_by
    while (next && !chain.includes(next)) {
      chain.push(next)
      next = byID.get(next)?.replaced_by ?? ""
    }
    chains.push(chain)
  }

  const top = Object.entries(facts)
    .filter(([id]) => byID.has(id))
    .map(([id, entry]) => ({ id, count: entry.recalls, last: entry.last }))
    .toSorted((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, 10)
  groups.top = top.map((item) => item.id)

  const dataSince = (input.events ?? []).reduce<string | null>((oldest, event) => {
    const at = typeof event.timestamp === "string" ? event.timestamp : undefined
    return at && (!oldest || at < oldest) ? at : oldest
  }, null)

  return {
    version: VERSION,
    generatedAt: input.now.toISOString(),
    rangeDays: input.days ?? null,
    since: since === undefined ? null : new Date(since).toISOString(),
    scopes,
    maxTokens: input.maxTokens,
    sources,
    growth: [...growth.values()].toSorted((a, b) => a.week.localeCompare(b.week) || a.scope.localeCompare(b.scope)),
    recall: {
      audit: input.events !== undefined,
      dataSince,
      total: recalls.length,
      perDay: Object.entries(perDay)
        .map(([day, count]) => ({ day, count }))
        .toSorted((a, b) => a.day.localeCompare(b.day)),
      origin,
      hitRate: recalls.length ? hits / recalls.length : null,
      avgFacts: recalls.length ? returned / recalls.length : null,
      truncatedRate: truncatable ? truncated / truncatable : null,
    },
    top,
    supersession: { count: groups.supersession?.length ?? 0, chains },
    facts,
    groups,
  }
}
