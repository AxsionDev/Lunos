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
  /** The template that set up the storage; undefined when it was chosen by hand ("Custom"). */
  template?: string
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
  backend?: {
    type?: string
    url?: string
    username?: string
    password?: string
    jurisdiction?: string
    database?: string
    allow_insecure?: boolean
  }
  retention?: { days?: number }
  encryption?: "os-keychain" | "off"
  template?: string
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
    template: memory?.template,
  }
}

/** The memory block these answers make, for the checks before saving. */
export function block(draft: Draft): Record<string, unknown> {
  return {
    enabled: draft.enabled,
    ...(draft.model ? { model: draft.model } : {}),
    // Explicit for this computer too: the block is layered over the config files (the check, Move),
    // where a team database may still be set.
    backend: draft.backend,
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
    // XCOD-264: another database doesn't inherit the old one's exceptions: an unencrypted connection
    // allowed to one host isn't allowed to the next, and a Neo4j database name means nothing to PostgreSQL.
    if (memory?.backend?.url !== draft.backend.url)
      set("memory.backend.allow_insecure", undefined, memory?.backend?.allow_insecure)
    if (memory?.backend?.type !== draft.backend.type)
      set("memory.backend.database", undefined, memory?.backend?.database)
  } else if (memory?.backend?.type && memory.backend.type !== "embedded") {
    set("memory.backend.type", "embedded", memory.backend.type)
  }
  set("memory.model", draft.model, memory?.model)
  set("memory.retention.days", draft.retentionDays ? String(draft.retentionDays) : undefined, memory?.retention?.days)
  set("memory.encryption", draft.encryption, memory?.encryption ?? "off")
  // Recorded next to the backend (and locked with it), so /memory can say which template set it up.
  if (!locked(rows, "memory.backend")) {
    if (draft.template === undefined) {
      if (memory?.template !== undefined) out.push({ key: "memory.template", unset: true })
    } else if (memory?.template !== draft.template) out.push({ key: "memory.template", value: draft.template })
  }
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

/** XCOD-264: the answers a template's memory block sets, on top of the current ones. */
export function apply(draft: Draft, memory: Record<string, unknown>): Draft {
  const backend = memory.backend as Record<string, string> | undefined
  return {
    ...draft,
    ...(backend
      ? {
          backend: database(backend.type)
            ? {
                type: backend.type,
                url: backend.url ?? "",
                username: backend.username ?? "",
                password: backend.password ?? "",
                jurisdiction: backend.jurisdiction ?? "",
              }
            : { type: "embedded" as const },
        }
      : {}),
    ...(typeof memory.model === "string" && memory.model ? { model: memory.model } : {}),
    ...(memory.encryption === "off" || memory.encryption === "os-keychain" ? { encryption: memory.encryption } : {}),
  }
}

/** Where the facts are now, for "Start empty: the old ones stay in …". */
export function location(memory: MemoryConfig | undefined, paths?: { project?: string; user?: string }) {
  if (database(memory?.backend?.type)) {
    let host = memory.backend.url ?? ""
    try {
      host = new URL(host).host
    } catch {}
    // A Docker template's database says so: "Neo4j in Docker on this computer (localhost:7687)".
    const docker = MemoryStorage.BUILTIN.find((item) => item.name === memory.template && item.compose)
    if (docker) return `${docker.title}${host ? ` (${host})` : ""}`
    return `${MemoryStorage.label(memory.backend.type)}${host ? ` at ${host}` : ""}`
  }
  const list = [paths?.project, paths?.user].filter(Boolean)
  return list.length ? list.join(" and ") : "memory on this computer"
}

/** Start empty, naming where the old facts stay. */
export function startEmpty(memory: MemoryConfig | undefined, paths?: { project?: string; user?: string }) {
  return `Start empty: the new storage starts with no facts; the old ones stay, untouched, in ${location(memory, paths)}.`
}

/**
 * XCOD-264: whether saving moves memory somewhere else, so existing facts need a decision (Move my
 * facts, or Start empty). Only when memory is already on: a first setup has nothing to move.
 */
export function switching(memory: MemoryConfig | undefined, draft: Draft) {
  if (memory?.enabled !== true || !draft.enabled) return false
  const before = database(memory.backend?.type) ? memory.backend : undefined
  const after = draft.backend.type === "embedded" ? undefined : draft.backend
  if (!before || !after) return !!before !== !!after
  return before.type !== after.type || (before.url ?? "") !== after.url
}

export const MOVE =
  "Move my facts: copies every fact, with where it came from, from the current storage to the new one (the old copy stays until you delete it)."
export const START_EMPTY = "Start empty: the new storage starts with no facts; the old ones stay where they are."
