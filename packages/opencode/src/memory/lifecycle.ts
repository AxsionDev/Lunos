export * as MemoryLifecycle from "./lifecycle"

import type { ConfigMemory } from "@opencode-ai/core/config/memory"
import { MemoryNotes } from "./notes"
import { MemoryStore } from "./store"

/**
 * A fact's life (XCOD-136): active, then possibly outdated (replaced, or just no longer true),
 * expired (past its `expires` date or `memory.retention.days`), and finally purged after the grace
 * period. Only active, unexpired, unquarantined facts are recalled.
 *
 * Simplified from Graphiti's bitemporal model: each fact has `valid_from` (when it was saved, or
 * when the fact it came from was) and, once outdated, `invalid_at`. There is no separate
 * transaction time: the ledger's provenance date is that.
 */

export const DEFAULT_GRACE_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

/**
 * The clock lifecycle checks use. `LUNOS_MEMORY_CLOCK` (an ISO date) moves it, for testing expiry
 * without waiting: it changes only what counts as expired, never a stored date or an audit time.
 */
export const CLOCK_ENV = "LUNOS_MEMORY_CLOCK"

export function now(env: Record<string, string | undefined> = process.env) {
  const value = env[CLOCK_ENV]
  if (value) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  return new Date()
}

export interface Retention {
  days?: number
  graceDays: number
}

export function retention(config: ConfigMemory.Info | undefined): Retention {
  return {
    days: config?.retention?.days,
    graceDays: config?.retention?.grace_days ?? DEFAULT_GRACE_DAYS,
  }
}

export function validFrom(fact: MemoryStore.Fact) {
  return fact.valid_from ?? fact.provenance.date
}

function fromNotes(fact: MemoryStore.Fact) {
  return fact.provenance.sessionID === MemoryNotes.SESSION
}

/**
 * When a fact expires: its own `expires` date, else `retention.days` after it became valid. Facts
 * from hand-written notes never expire: the note file is their source, and the notes sync would
 * only store them again.
 */
export function expiresAt(fact: MemoryStore.Fact, policy: Retention): Date | undefined {
  if (fromNotes(fact)) return undefined
  if (fact.expires) {
    const date = new Date(fact.expires)
    if (!Number.isNaN(date.getTime())) return date
  }
  if (!policy.days) return undefined
  const start = new Date(validFrom(fact))
  if (Number.isNaN(start.getTime())) return undefined
  return new Date(start.getTime() + policy.days * DAY)
}

export type State = "active" | "outdated" | "expired" | "purge" | "quarantined"

/** Where a fact is in its life. `purge`: expired and past the grace period, so due for deletion. */
export function state(fact: MemoryStore.Fact, policy: Retention, at: Date = now()): State {
  if (fact.quarantined) return "quarantined"
  const expires = expiresAt(fact, policy)
  if (expires && expires.getTime() <= at.getTime())
    return expires.getTime() + policy.graceDays * DAY <= at.getTime() ? "purge" : "expired"
  if (!MemoryStore.isActive(fact)) return "outdated"
  return "active"
}

export function recallable(fact: MemoryStore.Fact, policy: Retention, at: Date = now()) {
  return state(fact, policy, at) === "active"
}

/** Facts that expire within `days` of `at`, and those already expired but not yet purged. */
export function expiring(facts: MemoryStore.Fact[], policy: Retention, days: number, at: Date = now()) {
  const until = at.getTime() + days * DAY
  return facts
    .map((fact) => ({ fact, expires: expiresAt(fact, policy) }))
    .filter(
      (item): item is { fact: MemoryStore.Fact; expires: Date } => !!item.expires && item.expires.getTime() <= until,
    )
    .filter((item) => state(item.fact, policy, at) !== "purge")
    .toSorted((a, b) => a.expires.getTime() - b.expires.getTime())
}

// ---------------------------------------------------------------------------------------------
// Contradictions: the same subject with a different value.

export function words(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

/**
 * Whether two facts say different things about the same subject: they share their first and last
 * words and differ in one span between them, on both sides. The shared words must be at least two,
 * and at least half the shorter fact. So "billing owns invoices" and "ledger-service owns invoices"
 * contradict (subject changed), as do "the billing service owns the invoices table" and "... the
 * payments table" (value changed); "we deploy on Fridays" and "we deploy on Fridays after review"
 * don't (one only adds to the other).
 */
export function contradicts(a: string, b: string) {
  const x = words(a)
  const y = words(b)
  if (x.join(" ") === y.join(" ")) return false
  let prefix = 0
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++
  let suffix = 0
  while (
    suffix < x.length - prefix &&
    suffix < y.length - prefix &&
    x[x.length - 1 - suffix] === y[y.length - 1 - suffix]
  )
    suffix++
  const shared = prefix + suffix
  const differs = x.length - shared > 0 && y.length - shared > 0
  return differs && shared >= 2 && shared >= Math.min(x.length, y.length) / 2
}

/** The active fact a new one contradicts, if any: the candidate for "replace". */
export function contradicted(text: string, facts: MemoryStore.Fact[], policy: Retention, at: Date = now()) {
  return facts.find((fact) => recallable(fact, policy, at) && contradicts(text, fact.text))
}
