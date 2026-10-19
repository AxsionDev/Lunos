export * as MemorySetup from "./memory-setup"

import { MemoryStorage } from "./memory-storage"

// XCOD-249: the memory setup wizard's answers and what saving them writes, shared by the TUI
// (/settings → Memory → Set up memory…) and `lunos memory setup`. It writes the same keys as editing
// them one by one, through the same settings API, so validation, scope and locks are the same.

/** XCOD-264: a team database, Neo4j or PostgreSQL. */
export type Database = "neo4j" | "postgres"

export type Backend =
  | { type: "embedded" }
  | { type: Database; url: string; username: string; password: string; jurisdiction: string }

export function database(type: string | undefined): type is Database {
  return type === "neo4j" || type === "postgres"
}

export type Draft = {
  enabled: boolean
  backend: Backend
  /** undefined: the small model (`small_model`), or the main model when there is none. */
  model?: string
  /** undefined: keep facts until they're removed. */
  retentionDays?: number
  encryption: "os-keychain" | "off"
}

/** The keys the wizard writes. An organisation lock on any of them makes that step fixed. */
export const KEYS = [
  "memory.enabled",
  "memory.backend",
  "memory.model",
  "memory.retention.days",
  "memory.encryption",
] as const
export type Key = (typeof KEYS)[number]

export type Row = { key: string; value?: unknown; locked?: boolean; source?: string; override?: string }

type MemoryConfig = {
  enabled?: boolean
  model?: string
  backend?: { type?: string; url?: string; username?: string; password?: string; jurisdiction?: string }
  retention?: { days?: number }
  encryption?: "os-keychain" | "off"
}

export function locked(rows: readonly Row[], key: Key) {
  return rows.some(
    (row) => row.locked && (row.key === key || key.startsWith(row.key + ".") || row.key.startsWith(key + ".")),
  )
}

/** Why the wizard can't run at all: memory itself is locked off by the organisation. */
export function blocked(rows: readonly Row[], memory: MemoryConfig | undefined) {
  if (locked(rows, "memory.enabled") && memory?.enabled !== true)
    return "Memory is turned off by your organisation's policy (memory.enabled is locked), so it can't be set up here."
  return undefined
}

/** The recommended answers, or the current setup when memory is already configured. */
export function initial(memory: MemoryConfig | undefined): Draft {
  const backend = memory?.backend
  const external = database(backend?.type)
  return {
    enabled: true,
    backend: external
      ? {
          type: backend.type as Database,
          url: backend.url ?? "",
          username: backend.username ?? "",
          password: backend.password ?? "",
          jurisdiction: backend.jurisdiction ?? "",
        }
      : { type: "embedded" },
    model: memory?.model,
    retentionDays: memory?.retention?.days,
    // The OS keychain holds one person's key; a shared database is encrypted on the server instead.
    encryption: memory?.encryption ?? (external ? "off" : "os-keychain"),
  }
}

/** The memory block these answers make, for the checks before saving. */
export function block(draft: Draft): Record<string, unknown> {
  return {
    enabled: draft.enabled,
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.backend.type !== "embedded" ? { backend: draft.backend } : {}),
    ...(draft.retentionDays ? { retention: { days: draft.retentionDays } } : {}),
    encryption: draft.encryption,
  }
}

export type Write = { key: string; value: string } | { key: string; unset: true }

/**
 * The settings writes that turn the current config into the answers, skipping locked keys. Only
 * what differs is written, so pressing Enter through an unchanged setup writes nothing.
 */
export function writes(draft: Draft, memory: MemoryConfig | undefined, rows: readonly Row[]): Write[] {
  const out: Write[] = []
  const set = (key: Key | `memory.backend.${string}`, value: string | undefined, current: unknown) => {
    const root = (key.startsWith("memory.backend") ? "memory.backend" : key) as Key
    if (locked(rows, root)) return
    if (value === undefined) {
      if (current !== undefined) out.push({ key, unset: true })
      return
    }
    if (String(current) !== value) out.push({ key, value })
  }
  set("memory.enabled", String(draft.enabled), memory?.enabled)
  if (draft.backend.type !== "embedded") {
    set("memory.backend.type", draft.backend.type, memory?.backend?.type)
    set("memory.backend.url", draft.backend.url, memory?.backend?.url)
    set("memory.backend.username", draft.backend.username, memory?.backend?.username)
    set("memory.backend.password", draft.backend.password, memory?.backend?.password)
    set("memory.backend.jurisdiction", draft.backend.jurisdiction, memory?.backend?.jurisdiction)
  } else if (memory?.backend?.type && memory.backend.type !== "embedded") {
    set("memory.backend.type", "embedded", memory.backend.type)
  }
  set("memory.model", draft.model, memory?.model)
  set("memory.retention.days", draft.retentionDays ? String(draft.retentionDays) : undefined, memory?.retention?.days)
  set("memory.encryption", draft.encryption, memory?.encryption ?? "off")
  return out
}

/**
 * Settings that would still win over what the wizard saves: an environment variable, or the
 * project config when saving to the user config. Shown in the summary, so a passing check doesn't
 * promise memory will be on after Save when something else turns it off.
 */
export function conflicts(rows: readonly Row[], scope: "user" | "project") {
  const out: string[] = []
  for (const key of KEYS) {
    const row = rows.find((item) => item.key === key)
    if (!row || row.locked) continue
    if (row.override) out.push(`${key}: ${row.override}`)
    else if (scope === "user" && row.source === "project")
      out.push(`${key} is set in the project config, which wins over the user config`)
  }
  return out
}

/** "Memory: on · on this computer · model mistral/ministral-8b · encrypted" */
export function status(memory: MemoryConfig | undefined, off?: string) {
  if (off) return `Memory: off (${off})`
  if (memory?.enabled !== true) return "Memory: off"
  const where = MemoryStorage.short({ type: memory.backend?.type, jurisdiction: memory.backend?.jurisdiction })
  return [
    "Memory: on",
    where,
    memory.model ? `model ${memory.model}` : "small model",
    memory.encryption === "os-keychain" ? "encrypted" : "not encrypted",
    memory.retention?.days ? `kept ${memory.retention.days} days` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Step 4's text: what the first start fetches, and how much. */
export const DOWNLOAD =
  "The first start downloads about 180 Python packages from PyPI (through uv) and the all-MiniLM-L6-v2 embedding model from Hugging Face (about 87 MB). After that, memory needs no network."

export const OFFLINE_DOWNLOAD =
  "Offline (LUNOS_OFFLINE): nothing is downloaded, so uv's package cache and Lunos's memory/models directory must already be filled (run the check once on a machine with network access, or pre-seed them as the memory docs describe)."
