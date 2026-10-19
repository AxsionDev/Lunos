import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import type { MemoryStats } from "@opencode-ai/sdk/v2"

// XCOD-252: /memory's Overview and Activity tabs as list rows. Each count carries the drill-down
// key its fact ids are under in `stats.groups`; selecting it opens the Facts tab on exactly those.

export type Row = {
  title: string
  value: string
  category?: string
  footer?: string
  /** `stats.groups` key; undefined for a row that only informs. */
  group?: string
}

const BARS = "▁▂▃▄▅▆▇█"

/** A one-line bar chart, scaled to the largest value. */
export function sparkline(values: readonly number[]) {
  const max = Math.max(0, ...values)
  if (!max) return values.map(() => BARS[0]).join("")
  return values.map((value) => BARS[Math.min(BARS.length - 1, Math.round((value / max) * (BARS.length - 1)))]).join("")
}

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`

export function statusLine(stats: MemoryStats) {
  const s = stats.status
  const backend = MemoryStorage.short(s.backend)
  return [
    s.on ? "Memory: on" : `Memory: off (${s.reason})`,
    backend,
    s.encryption === "os-keychain" ? "encrypted" : "not encrypted",
    s.retentionDays ? `kept ${s.retentionDays} days` : "kept until removed",
  ].join(" · ")
}

export function overviewRows(stats: MemoryStats): Row[] {
  const rows: Row[] = [
    { title: statusLine(stats), value: "status", category: "Status" },
    {
      title: `Leaves the computer: ${MemoryStorage.leaves(stats.status.backend.type, undefined, stats.status.backend.host ?? undefined)}`,
      value: "leaves",
      category: "Status",
    },
  ]
  for (const scope of stats.scopes) {
    const category = scope.scope === "project" ? "Project memory" : "User memory"
    if (scope.error) {
      rows.push({ title: `can't be read: ${scope.error}`, value: `${scope.scope}:error`, category })
      continue
    }
    const c = scope.counts
    const count = (state: keyof typeof c, title: string, group: string) =>
      rows.push({ title, value: group, category, footer: String(c[state]), group })
    count("active", "Active", `state:${scope.scope}:active`)
    count("outdated", "Outdated", `state:${scope.scope}:outdated`)
    count("expiring", "Expiring within 7 days", `expiring:${scope.scope}`)
    count("expired", "Expired, awaiting deletion", `state:${scope.scope}:expired`)
    count("quarantined", "Quarantined", `state:${scope.scope}:quarantined`)
    rows.push({
      title: "Last write",
      value: `${scope.scope}:last`,
      category,
      footer: scope.lastWrite?.slice(0, 16).replace("T", " ") ?? "never",
    })
    rows.push({
      title: `Size: ${scope.chars} chars ≈ ${scope.tokens} tokens`,
      value: `${scope.scope}:size`,
      category,
      footer: `${stats.maxTokens} fit one recall`,
    })
  }
  const from = "Where it came from"
  for (const [type, n] of Object.entries(stats.sources.source))
    rows.push({
      title: `From ${type === "user message" ? "your messages" : type === "file" ? "files" : "tools"}`,
      value: `source:${type}`,
      category: from,
      footer: String(n),
      group: `source:${type}`,
    })
  for (const [agent, n] of Object.entries(stats.sources.agent).toSorted((a, b) => b[1] - a[1]))
    rows.push({
      title: `By agent ${agent}`,
      value: `agent:${agent}`,
      category: from,
      footer: String(n),
      group: `agent:${agent}`,
    })
  for (const [kind, n] of Object.entries(stats.sources.kind))
    rows.push({
      title: kind === "inferred" ? "Inferred by the agent" : "Observed",
      value: `kind:${kind}`,
      category: from,
      footer: String(n),
      group: `kind:${kind}`,
    })
  rows.push({ title: "Native", value: "native", category: from, footer: String(stats.sources.native), group: "native" })
  for (const [origin, n] of Object.entries(stats.sources.imported))
    rows.push({
      title: `Imported from ${origin}`,
      value: `imported:${origin}`,
      category: from,
      footer: String(n),
      group: `imported:${origin}`,
    })
  const health = "Health"
  const quarantined = stats.groups.quarantined?.length ?? 0
  rows.push({
    title: "Quarantined (failed the integrity check)",
    value: "quarantined",
    category: health,
    footer: String(quarantined),
    group: "quarantined",
  })
  for (const item of stats.status.health) {
    if (item.error) {
      rows.push({
        title: `${item.scope}: ledger can't be read: ${item.error}`,
        value: `health:${item.scope}`,
        category: health,
      })
      continue
    }
    rows.push({
      title: `${item.scope} ledger ${item.problems ? `has ${item.problems} problem(s) — run lunos memory verify` : "sealed"}`,
      value: `health:${item.scope}`,
      category: health,
    })
    const plain = item.facts - item.encrypted
    if (item.unsealed || (stats.status.encryption === "os-keychain" && plain > 0))
      rows.push({
        title: `WARNING: ${item.unsealed ? `${item.unsealed} unsealed` : ""}${item.unsealed && plain ? ", " : ""}${stats.status.encryption === "os-keychain" && plain ? `${plain} unencrypted` : ""} line(s) in ${item.scope} memory`,
        value: `health:${item.scope}:warn`,
        category: health,
      })
  }
  return rows
}

export function activityRows(stats: MemoryStats, text: (id: string) => string | undefined): Row[] {
  const rows: Row[] = []
  const growth = "Growth per week"
  const weeks = [...new Set(stats.growth.map((row) => row.week))]
  for (const week of weeks) {
    const sum = (field: "added" | "outdated" | "forgotten" | "expired") =>
      stats.growth.filter((row) => row.week === week).reduce((total, row) => total + row[field], 0)
    rows.push({
      title: `${week}  +${sum("added")} added · ${sum("outdated")} outdated · ${sum("forgotten")} forgotten · ${sum("expired")} expired`,
      value: `week:${week}`,
      category: growth,
    })
  }
  if (!weeks.length)
    rows.push({
      title: "Nothing added, outdated, forgotten or expired in this range",
      value: "growth:none",
      category: growth,
    })
  const recall = "Recall"
  const r = stats.recall
  if (!r.audit) {
    rows.push({
      title: "The audit log is off, so recalls aren't recorded (turn on audit.enabled to see them)",
      value: "recall:off",
      category: recall,
    })
  } else {
    if (r.dataSince && stats.since && r.dataSince > stats.since)
      rows.push({ title: `Recall data since ${r.dataSince.slice(0, 10)}`, value: "recall:since", category: recall })
    rows.push({
      title: `Recalls per day  ${sparkline(r.perDay.map((item) => item.count))}`,
      value: "recall:days",
      category: recall,
      footer: `${r.total} total`,
    })
    rows.push({
      title: `By origin: ${
        Object.entries(r.origin)
          .map(([key, n]) => `${key} ${n}`)
          .join(", ") || "none"
      }`,
      value: "recall:origin",
      category: recall,
    })
    rows.push({ title: "Returned at least one fact", value: "recall:hit", category: recall, footer: pct(r.hitRate) })
    rows.push({
      title: "Facts per recall, on average",
      value: "recall:avg",
      category: recall,
      footer: r.avgFacts === null ? "n/a" : r.avgFacts.toFixed(1),
    })
    rows.push({ title: "Hit the token cap", value: "recall:cap", category: recall, footer: pct(r.truncatedRate) })
    const top = "Top recalled"
    for (const item of stats.top)
      rows.push({
        title: (text(item.id) ?? item.id).replace(/\s+/g, " "),
        value: `fact:${item.id}`,
        category: top,
        footer: `${item.count}×`,
        group: `fact:${item.id}`,
      })
    rows.push({
      title: "Never recalled (active, 14+ days old): clean-up candidates",
      value: "never",
      category: "Clean-up",
      footer: String(stats.groups.never?.length ?? 0),
      group: "never",
    })
  }
  rows.push({
    title: "Replaced by a newer fact",
    value: "supersession",
    category: "Clean-up",
    footer: String(stats.supersession.count),
    group: "supersession",
  })
  return rows
}

/** The fact ids behind a row, `fact:<id>` meaning that one fact. */
export function idsFor(stats: MemoryStats, group: string) {
  if (group.startsWith("fact:")) return [group.slice("fact:".length)]
  return stats.groups[group] ?? []
}
