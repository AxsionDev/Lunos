import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import { MemoryStatsLoad } from "@/memory/stats-load"
import type { MemoryStats } from "@/memory/stats"

// XCOD-252: the numbers /memory's Overview and Activity tabs show, on the command line.

const pct = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`)
const list = (record: Record<string, number>) =>
  Object.entries(record)
    .toSorted((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key} ${count}`)
    .join(", ") || "none"

export function statsLines(
  stats: MemoryStats.Stats & {
    status: {
      on: boolean
      reason: string | null
      backend: { type: string; host: string | null; jurisdiction: string | null }
      encryption: string
      retentionDays: number | null
    }
  },
) {
  const status = stats.status
  const backend =
    status.backend.type === "embedded"
      ? "this machine"
      : `${status.backend.type}${status.backend.host ? ` at ${status.backend.host}` : ""}${status.backend.jurisdiction ? ` (${status.backend.jurisdiction})` : ""}`
  const lines = [
    `Memory: ${status.on ? "on" : `off (${status.reason})`} · ${backend} · ${status.encryption === "os-keychain" ? "encrypted" : "not encrypted"} · ${status.retentionDays ? `kept ${status.retentionDays} days` : "kept until removed"}`,
    `Range: ${stats.rangeDays ? `last ${stats.rangeDays} days` : "all"}`,
    "",
  ]
  for (const scope of stats.scopes) {
    if (scope.error) {
      lines.push(`${scope.scope}: can't be read: ${scope.error}`)
      continue
    }
    const c = scope.counts
    lines.push(
      `${scope.scope}: ${c.active} active, ${c.outdated} outdated, ${c.expiring} expiring, ${c.expired} expired, ${c.quarantined} quarantined · last write ${scope.lastWrite ?? "never"}`,
      `  size: ${scope.chars} chars ≈ ${scope.tokens} tokens (one recall fits ${stats.maxTokens})`,
    )
  }
  lines.push(
    "",
    `Sources: ${list(stats.sources.source)}`,
    `Agents: ${list(stats.sources.agent)}`,
    `Kind: ${list(stats.sources.kind)}`,
    `Native ${stats.sources.native}, imported: ${list(stats.sources.imported)}`,
    "",
  )
  const added = stats.growth.reduce((sum, row) => sum + row.added, 0)
  const outdated = stats.growth.reduce((sum, row) => sum + row.outdated, 0)
  const forgotten = stats.growth.reduce((sum, row) => sum + row.forgotten, 0)
  const expired = stats.growth.reduce((sum, row) => sum + row.expired, 0)
  lines.push(`Growth: ${added} added, ${outdated} outdated, ${forgotten} forgotten, ${expired} expired`)
  const recall = stats.recall
  if (!recall.audit) lines.push("Recall: the audit log is off (audit.enabled), so recalls aren't recorded")
  else {
    if (recall.dataSince && stats.since && recall.dataSince > stats.since)
      lines.push(`Recall data since ${recall.dataSince.slice(0, 10)}`)
    lines.push(
      `Recall: ${recall.total} recalls (${list(recall.origin)}), ${pct(recall.hitRate)} returned a fact, ${recall.avgFacts === null ? "n/a" : recall.avgFacts.toFixed(1)} facts on average, ${pct(recall.truncatedRate)} hit the token cap`,
      `Top recalled: ${stats.top.map((item) => `${item.id} (${item.count})`).join(", ") || "none"}`,
      `Never recalled (active, 14+ days old): ${stats.groups.never?.length ?? 0}`,
    )
  }
  lines.push(`Replaced by a newer fact: ${stats.supersession.count}`)
  return lines
}

export const MemoryStatsCommand = effectCmd({
  command: "stats",
  describe: "what's in memory, where it came from, how it grows and which facts are recalled",
  builder: (yargs) =>
    yargs
      .option("scope", { choices: ["project", "user"] as const, describe: "only this memory (default: both)" })
      .option("days", { type: "number", describe: "only the last N days for growth and recall (default: all)" })
      .option("json", { type: "boolean", describe: "print everything as JSON (schema in the docs)" }),
  handler: Effect.fn("Cli.memory.stats")(function* (args: {
    scope?: "project" | "user"
    days?: number
    json?: boolean
  }) {
    const stats = yield* MemoryStatsLoad.load({
      scope: args.scope,
      days: args.days && args.days > 0 ? args.days : undefined,
    })
    yield* writeStdoutEffect((args.json ? JSON.stringify(stats, null, 2) : statsLines(stats).join(EOL)) + EOL)
  }),
})
