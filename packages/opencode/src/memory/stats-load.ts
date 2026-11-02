export * as MemoryStatsLoad from "./stats-load"

import { Effect } from "effect"
import { Audit } from "@opencode-ai/core/audit"
import { AuditLog } from "@/audit/log"
import { Config } from "@/config/config"
import { Memory } from "."
import { MemoryLifecycle } from "./lifecycle"
import { MemoryRecall } from "./recall"
import { MemoryStats } from "./stats"
import type { MemoryStore } from "./store"

// XCOD-252: what the analytics are computed from. Reads the ledger and the local audit log only:
// it never starts memory, and with memory off and an external backend nothing is opened at all
// (the same rule as `lunos memory status`, XCOD-134).

export const load = Effect.fn("MemoryStats.load")(function* (input: { scope?: MemoryStore.Scope; days?: number }) {
  const memory = yield* Memory.Service
  const cfg = yield* Config.Service.use((config) => config.get())
  const verdict = yield* memory.decision()
  const policy = yield* memory.policy()
  const where = yield* memory.where()
  const external = where.type !== "embedded"
  const wanted: MemoryStore.Scope[] = input.scope ? [input.scope] : ["project", "user"]
  const scopes: MemoryStats.ScopeInput[] = []
  if (!(external && !verdict.on))
    for (const scope of wanted) {
      const last = where.scopes.find((item) => item.scope === scope)
      const facts = yield* memory.facts(scope).pipe(
        Effect.map((list) => ({ facts: list })),
        Effect.catch((error) => Effect.succeed({ facts: [] as MemoryStore.Fact[], error: error.message })),
      )
      scopes.push({
        scope,
        facts: facts.facts,
        lastWrite: last?.lastWrite,
        error: "error" in facts ? facts.error : last?.error,
      })
    }
  // Ledger health, with the same numbers as `lunos memory status` / `verify` (nothing is audited).
  const health = external && !verdict.on ? [] : yield* memory.verify({ origin: "tui", audit: false })
  const audit = AuditLog.resolve(cfg)
  const now = MemoryLifecycle.now()
  const events = audit.enabled
    ? yield* Effect.promise(() => Audit.read(audit.file).catch(() => [] as Record<string, unknown>[])).pipe(
        Effect.map((list) => list.filter((event) => String(event.event).startsWith("memory."))),
      )
    : undefined
  const stats = MemoryStats.compute({
    now,
    days: input.days,
    scopes,
    retention: policy.retention,
    maxTokens: cfg.memory?.retrieval?.max_tokens ?? MemoryRecall.DEFAULT_MAX_TOKENS,
    events,
    expiringDays: MemoryLifecycle.DEFAULT_EXPIRING_DAYS,
  })
  return {
    ...stats,
    status: {
      on: verdict.on,
      reason: verdict.on ? null : verdict.reason,
      backend: { type: where.type, host: where.host ?? null, jurisdiction: where.jurisdiction ?? null },
      encryption: policy.encryption,
      retentionDays: policy.retention.days ?? null,
      graceDays: policy.retention.graceDays,
      health: health
        .filter((item) => !input.scope || item.scope === input.scope)
        .map((item) => ({
          scope: item.scope,
          facts: item.facts,
          problems: item.problems.length,
          unsealed: item.unsealed,
          encrypted: item.encrypted,
          error: item.error ?? null,
        })),
    },
  }
})

export type Loaded = MemoryStats.Stats & { status: Record<string, unknown> }
