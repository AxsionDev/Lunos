export * as MemoryStorage from "./memory-storage"

import justMe from "./memory-templates/just-me.json" with { type: "json" }
import fullyLocal from "./memory-templates/fully-local.json" with { type: "json" }
import neo4jDocker from "./memory-templates/neo4j-docker.json" with { type: "json" }
import postgresDocker from "./memory-templates/postgres-docker.json" with { type: "json" }
import teamHosted from "./memory-templates/team-hosted.json" with { type: "json" }
import managedCloud from "./memory-templates/managed-cloud.json" with { type: "json" }

// XCOD-264: the "Where should memory be stored?" step, in plain words. One place for the labels,
// the cards' "What this means", Compare, Help me choose and the templates, so the TUI wizard,
// `lunos memory setup`, `lunos memory status`, the status line and /memory say the same thing.
// The config value for memory on this computer stays "embedded"; no UI text shows that word.

export type Kind = "embedded" | "neo4j" | "postgres" | "memgraph"

/** What only the machine knows: the memory paths, the extraction model and its region, Docker. */
export type Environment = {
  /** Where each scope's memory is on this computer (embedded). */
  paths: { project?: string; user?: string }
  /** The model that extracts facts: "provider/model", and where the provider processes data. */
  model?: { id: string; region?: string }
  /** `docker` or `podman` with compose, if found. */
  docker?: { tool: "docker" | "podman"; compose: boolean }
  /** Configured providers whose endpoint is on this computer (Ollama, LM Studio), as "provider/model". */
  localModels: string[]
}

export function label(kind: Kind | string | undefined) {
  switch (kind) {
    case "neo4j":
      return "Team database: Neo4j"
    case "postgres":
      return "Team database: PostgreSQL"
    case "memgraph":
      return "Team database: Memgraph"
    default:
      return "On this computer"
  }
}

/** The status line's short form: "on this computer", "Neo4j at graph.internal (EU-DE)". */
export function short(backend: { type?: string; host?: string | null; jurisdiction?: string | null } | undefined) {
  const type = backend?.type ?? "embedded"
  if (type === "embedded") return "on this computer"
  const name = type === "postgres" ? "PostgreSQL" : type === "memgraph" ? "Memgraph" : "Neo4j"
  return `${name}${backend?.host ? ` at ${backend.host}` : ""}${backend?.jurisdiction ? ` (${backend.jurisdiction})` : ""}`
}

function where(paths: Environment["paths"]) {
  const list = [paths.project, paths.user].filter(Boolean)
  return list.length ? list.join(" and ") : "the Lunos memory directory"
}

function model(env: Environment) {
  if (!env.model) return "your model (none is configured yet)"
  return `your model ${env.model.id}${env.model.region ? ` (${env.model.region})` : ""}`
}

/** The "what leaves the computer" sentence, the same everywhere memory storage is shown. */
export function leaves(kind: Kind | string | undefined, env?: Environment, host?: string) {
  if (kind === "neo4j" || kind === "postgres" || kind === "memgraph")
    return `the fact text, to ${host ? `your database at ${host}` : "that database"} only. No model calls.`
  if (env && env.model && env.localModels.includes(env.model.id))
    return `nothing. Your model ${env.model.id} runs on this computer, and search embeddings are made here too.`
  return `the fact text, sent to ${env ? model(env) : "your model"} to pull out names and relationships. Search embeddings are made on this computer.`
}

export type Card = {
  kind: Kind
  title: string
  summary: string
  recommended?: string
  /** Shown greyed out with this reason; can't be picked. */
  unavailable?: string
  meaning: { label: string; text: string }[]
}

/** The cards, in order. `host` is the database host, when one is already entered. */
export function cards(env: Environment, input?: { host?: string; memgraph?: boolean }): Card[] {
  const db = (name: string, search: string): Card["meaning"] => [
    { label: "Stored", text: `in your ${name}${input?.host ? ` at ${input.host}` : ""}.` },
    { label: "Leaves the computer", text: leaves("neo4j", env, input?.host) },
    { label: "Shared", text: "with everyone using the same database and scope." },
    { label: "Needs", text: `the database's URL, a user and a password (environment variables recommended).` },
    { label: "Search", text: search },
  ]
  return [
    {
      kind: "embedded",
      title: label("embedded"),
      summary: "Private to you, nothing to set up.",
      recommended: "recommended for one person",
      meaning: [
        {
          label: "Stored",
          text: `in ${where(env.paths)} on this computer, in SQLite, LanceDB and a local graph.`,
        },
        { label: "Leaves the computer", text: leaves("embedded", env) },
        { label: "Shared", text: "no, only you." },
        { label: "Needs", text: "nothing; uses about 300 MB on first start for the engine and the embedding model." },
        { label: "Encryption", text: "optional (a key in your OS keychain)." },
      ],
    },
    {
      kind: "neo4j",
      title: label("neo4j"),
      summary: "Shared with your team, in a Neo4j you run.",
      meaning: db("Neo4j", "keyword (full-text), with no relationship graph."),
    },
    {
      kind: "postgres",
      title: label("postgres"),
      summary: "Shared with your team, in a PostgreSQL you run.",
      meaning: db("PostgreSQL", "keyword (PostgreSQL full-text search), with no relationship graph."),
    },
    {
      kind: "memgraph",
      title: label("memgraph"),
      summary: "Shared with your team, in a Memgraph you run.",
      ...(input?.memgraph ? {} : { unavailable: "Coming soon" }),
      meaning: db("Memgraph", "keyword (full-text), with no relationship graph."),
    },
  ]
}

/** "What this means", one line per row: "Stored: in …". */
export function meaning(card: Card) {
  return card.meaning.map((row) => `${row.label}: ${row.text}`)
}

export const COMPARE_ROWS = [
  "Where it's stored",
  "What leaves the computer",
  "Model calls",
  "Shared",
  "Search type",
  "Setup needed",
  "Offline use",
] as const

/** Compare: the cards side by side, one row per question. */
export function compare(env: Environment) {
  const local = !!env.model && env.localModels.includes(env.model.id)
  const db = (name: string): string[] => [
    `your ${name}`,
    "the fact text, to the database",
    "none",
    "with your team",
    "keyword (full-text)",
    "URL, user, password",
    "only if the database is on this computer",
  ]
  const columns: { title: string; values: string[] }[] = [
    {
      title: label("embedded"),
      values: [
        "this computer",
        local ? "nothing" : "the fact text, to your model",
        local ? "your local model" : "your model, when a fact is saved",
        "no, only you",
        "meaning (embeddings) and a graph",
        "none (~300 MB on first start)",
        local ? "yes" : "recall yes; saving needs your model",
      ],
    },
    { title: label("neo4j"), values: db("Neo4j") },
    { title: label("postgres"), values: db("PostgreSQL") },
  ]
  return { rows: [...COMPARE_ROWS], columns }
}

/** Compare as fixed-width text lines, for the CLI and the TUI. A cell too long for its column wraps. */
export function compareLines(env: Environment, width = 26) {
  const table = compare(env)
  const head = 25
  const wrap = (text: string, size: number) => {
    const out: string[] = []
    let line = ""
    for (const word of text.split(" ")) {
      if (line && line.length + 1 + word.length > size) {
        out.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    return [...out, line]
  }
  const row = (cells: string[][]) => {
    const height = Math.max(...cells.map((cell) => cell.length))
    return Array.from({ length: height }, (_, index) =>
      cells
        .map((cell, column) => (cell[index] ?? "").padEnd(column === 0 ? head : width))
        .join(" ")
        .trimEnd(),
    )
  }
  return [
    ...row([[""], ...table.columns.map((column) => wrap(column.title, width))]),
    ...table.rows.flatMap((name, index) =>
      row([wrap(name, head), ...table.columns.map((column) => wrap(column.values[index] ?? "", width))]),
    ),
  ]
}

export const HELP_QUESTIONS = {
  who: {
    message: "Just you, or your team?",
    options: [
      { value: "me", label: "Just me" },
      { value: "team", label: "My team" },
    ],
  },
  runs: {
    message: "Do you already run one of these databases?",
    options: [
      { value: "postgres", label: "PostgreSQL" },
      { value: "neo4j", label: "Neo4j" },
      { value: "none", label: "Neither" },
    ],
  },
} as const

export type Who = "me" | "team"
export type Runs = "postgres" | "neo4j" | "none"

/** Help me choose: two answers, one recommendation and why. */
export function choose(input: { who: Who; runs: Runs }): { kind: Kind; reason: string } {
  if (input.who === "me")
    return {
      kind: "embedded",
      reason: "Just you: memory on this computer needs no database, and nothing is shared.",
    }
  if (input.runs === "neo4j")
    return { kind: "neo4j", reason: "Your team already runs Neo4j, so everyone can share one memory there." }
  if (input.runs === "postgres")
    return { kind: "postgres", reason: "Your team already runs PostgreSQL, so everyone can share one memory there." }
  return {
    kind: "postgres",
    reason:
      'A team needs a shared database, and PostgreSQL is the one most teams already know. To try it first, use the template "PostgreSQL in Docker on this computer".',
  }
}

// ---------------------------------------------------------------------------------------------
// Templates (XCOD-264 PO addition): ready-made setups. Data, not code: memory-templates/*.json,
// plus an organisation's own in managed config (`memory.templates.custom`), minus `hide`.

export type Requirement = "docker" | "local-model"

export type Template = {
  name: string
  title: string
  description?: string
  /** What leaves the computer, in plain words. */
  leaves: string
  requires?: Requirement[]
  /** Answers the template still needs: the database kind, its URL and where it runs. */
  ask?: ("vendor" | "url" | "jurisdiction")[]
  memory: Record<string, unknown>
  /** Docker templates: the compose file's lines, the env file, the default host port, the licence. */
  compose?: string[]
  env?: Record<string, string>
  port?: number
  licence?: string
  /** From managed config. */
  organisation?: boolean
}

export const BUILTIN: readonly Template[] = [
  justMe,
  fullyLocal,
  neo4jDocker,
  postgresDocker,
  teamHosted,
  managedCloud,
] as Template[]

export type Listed = Template & { unavailable?: string }

export const DOCKER_MISSING = "Docker or Podman not found"
export const DOCKER_INSTALL = "https://docs.docker.com/get-docker/"
export const COMPOSE_MISSING = "Docker Compose not found"
export const COMPOSE_INSTALL = "https://docs.docker.com/compose/install/"

/** The templates to offer: the organisation's first, then the built-ins not hidden, each with why it can't be used. */
export function templates(
  env: Environment,
  config?: { custom?: readonly Omit<Template, "organisation">[]; hide?: readonly string[] },
): Listed[] {
  const hidden = new Set(config?.hide ?? [])
  const custom = (config?.custom ?? []).map((item) => ({ ...item, organisation: true }) as Template)
  const names = new Set(custom.map((item) => item.name))
  return [...custom, ...BUILTIN.filter((item) => !hidden.has(item.name) && !names.has(item.name))].flatMap(
    (item): Listed[] => {
      const requires = item.requires ?? []
      // "Fully local" is offered only when a local model is configured: without one it has nothing to set.
      if (requires.includes("local-model") && !env.localModels.length) return []
      if (requires.includes("docker") && !env.docker)
        return [{ ...item, unavailable: `${DOCKER_MISSING} (install: ${DOCKER_INSTALL})` }]
      if (requires.includes("docker") && !env.docker?.compose)
        return [{ ...item, unavailable: `${COMPOSE_MISSING} (install: ${COMPOSE_INSTALL})` }]
      return [item]
    },
  )
}

export function find(list: readonly Listed[], name: string) {
  return list.find((item) => item.name === name)
}

/**
 * The memory block a template sets, with its placeholders filled: `{port}`, `{local-model}`, and
 * for templates that ask, `{vendor}`, `{VENDOR}`, `{url}` and `{jurisdiction}`.
 */
export function memoryOf(
  template: Template,
  values: { port?: number; localModel?: string; vendor?: "neo4j" | "postgres"; url?: string; jurisdiction?: string },
): Record<string, unknown> {
  const fill = (text: string) =>
    text
      .replaceAll("{port}", String(values.port ?? template.port ?? ""))
      .replaceAll("{local-model}", values.localModel ?? "")
      .replaceAll("{vendor}", values.vendor ?? "")
      .replaceAll("{VENDOR}", (values.vendor ?? "").toUpperCase())
      .replaceAll("{url}", values.url ?? "")
      .replaceAll("{jurisdiction}", values.jurisdiction ?? "")
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return fill(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    return value
  }
  return walk(template.memory) as Record<string, unknown>
}

/** The compose file and the env file a Docker template writes. `password` is generated by the caller. */
export function files(template: Template, values: { password: string; port?: number; project: string }) {
  const fill = (text: string) =>
    text
      .replaceAll("{password}", values.password)
      .replaceAll("{port}", String(values.port ?? template.port ?? ""))
      .replaceAll("{project}", values.project)
  const env = Object.entries(template.env ?? {})
  return {
    compose: (template.compose ?? []).map(fill).join("\n") + "\n",
    env: env.map(([key, value]) => `${key}=${fill(value)}`).join("\n") + "\n",
    example: env.map(([key, value]) => `${key}=${value === "{password}" ? "" : fill(value)}`).join("\n") + "\n",
  }
}

// ---------------------------------------------------------------------------------------------
// The Storage panel: what memory uses now, and its live status. The server fills `Panel` from the
// config and this machine (credentials as reference names only, never values); /memory's Overview
// and `lunos memory status` print it through `panelLines`, so both say the same thing.

export type Place = "embedded" | "docker" | "team" | "cloud"

export type ContainerState = "running" | "stopped" | "missing" | "no-docker"

export type Panel = {
  on: boolean
  /** Why memory is off. */
  reason?: string
  place: Place
  vendor?: Kind
  /** The template that set it up; undefined means set up by hand ("Custom"). */
  template?: { name: string; title: string; scope?: "user" | "project" }
  /** memory.backend is set by the organisation: it can't be changed here. */
  locked: boolean
  leaves: string
  encryption: "os-keychain" | "off"
  retentionDays?: number
  /** On this computer. */
  paths?: string[]
  bytes?: number
  model?: { id: string; region?: string }
  /** A database: its URL without credentials, host, region and TLS. */
  url?: string
  host?: string
  jurisdiction?: string
  tls?: "verified" | "unverified" | "none"
  readOnly?: boolean
  /** Where the credentials come from: `{env:…}` variable names or `{file:…}` paths, never values. */
  credentials?: string[]
  /** Managed cloud. */
  provider?: string
  residency?: { allowed: boolean; reason?: string }
  /** A database in Docker. */
  container?: { tool: "docker" | "podman"; name?: string; image?: string; state: ContainerState; project: string }
  status: {
    state: "connected" | "unreachable" | "unchecked" | "off"
    error?: { stage: string; message: string; fix?: string }
    /** ISO time of the last check. */
    at?: string
    ms?: number
    server?: string
  }
}

const VENDOR: Record<Kind, string> = { embedded: "", neo4j: "Neo4j", postgres: "PostgreSQL", memgraph: "Memgraph" }

/** "Neo4j Aura" for its hosts, else the vendor. */
export function cloudProvider(vendor: Kind | undefined, host: string | undefined) {
  if (host && /\.neo4j\.io$/i.test(host)) return "Neo4j Aura"
  if (host && /\.rds\.amazonaws\.com$/i.test(host)) return "Amazon RDS"
  if (host && /\.postgres\.database\.azure\.com$/i.test(host)) return "Azure Database for PostgreSQL"
  if (host && /\.supabase\.(co|com)$/i.test(host)) return "Supabase"
  if (host && /\.neon\.tech$/i.test(host)) return "Neon"
  return vendor ? `${VENDOR[vendor]} (managed)` : "managed database"
}

/** "{env:NEO4J_PASSWORD}" → "NEO4J_PASSWORD"; "{file:~/pw}" → "file ~/pw". Anything else isn't shown. */
export function reference(value: unknown) {
  if (typeof value !== "string") return undefined
  const env = /^\{env:([^}]+)\}$/.exec(value.trim())
  if (env) return env[1]
  const file = /^\{file:([^}]+)\}$/.exec(value.trim())
  if (file) return `file ${file[1]}`
  return undefined
}

/** The panel's title: "On this computer", "Neo4j in Docker on this computer", "Team database: Neo4j". */
export function panelTitle(panel: Panel) {
  if (!panel.on) return "Memory is off"
  if (panel.place === "embedded") return label("embedded")
  if (panel.place === "docker")
    return panel.template?.title ?? `${VENDOR[panel.vendor ?? "neo4j"]} in Docker on this computer`
  if (panel.place === "cloud")
    return `Managed cloud database: ${panel.provider ?? cloudProvider(panel.vendor, panel.host)}`
  return label(panel.vendor)
}

/** The status, as words with a symbol: never colour alone. */
export function panelStatus(panel: Panel) {
  switch (panel.status.state) {
    case "connected":
      return "● connected"
    case "unreachable":
      return "✗ unreachable"
    case "off":
      return "○ memory off"
    default:
      return "○ not checked yet"
  }
}

/** "just now", "2 min ago", "3 h ago", "4 days ago". */
export function ago(at: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000))
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  const days = Math.floor(seconds / 86_400)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

/** 1536 → "1.5 KB". */
export function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

const TLS = { verified: "TLS on", unverified: "TLS on (certificate not verified)", none: "TLS off" } as const

const CONTAINER: Record<ContainerState, string> = {
  running: "● running",
  stopped: "○ stopped",
  missing: "✗ missing (not created yet, or removed)",
  "no-docker": "✗ Docker or Podman not found",
}

/** The panel's lines under its title and status, the same in the TUI and `lunos memory status`. */
export function panelLines(panel: Panel, now = Date.now()) {
  if (!panel.on) return [`${panel.reason ? `${panel.reason}. ` : ""}Nothing is remembered or recalled.`]
  const lines: string[] = []
  if (panel.place === "embedded") {
    lines.push(
      `Path: ${panel.paths?.length ? panel.paths.join(" and ") : "the Lunos memory directory"}${panel.bytes !== undefined ? ` · ${size(panel.bytes)} on disk` : ""}`,
    )
    lines.push(
      `Model: ${panel.model ? `${panel.model.id}${panel.model.region ? ` (${panel.model.region})` : ""}` : "none configured yet"}`,
    )
  } else {
    const where = panel.place === "docker" ? (panel.url ?? panel.host) : panel.host
    lines.push(
      [
        where ? `${panel.place === "docker" ? "" : "Host: "}${where}` : undefined,
        panel.place === "docker" ? undefined : `jurisdiction ${panel.jurisdiction ?? "not set"}`,
        panel.place !== "docker" && panel.tls ? TLS[panel.tls] : undefined,
        panel.readOnly ? "read-only" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    )
    if (panel.container)
      lines.push(
        `Container: ${panel.container.name ?? panel.container.project}${panel.container.image ? ` (${panel.container.image})` : ""} · ${CONTAINER[panel.container.state]}`,
      )
    if (panel.place === "cloud")
      lines.push(
        `Provider: ${panel.provider ?? cloudProvider(panel.vendor, panel.host)} · region ${panel.jurisdiction ?? "not set"} · residency: ${panel.residency ? (panel.residency.allowed ? "allowed" : `blocked (${panel.residency.reason ?? "by your policy"})`) : "not checked"}`,
      )
    if (panel.credentials?.length) lines.push(`Credentials: from ${panel.credentials.join(" and ")} (never shown)`)
  }
  const checked = panel.status.at
    ? ` · checked ${ago(panel.status.at, now)}${panel.status.ms !== undefined ? ` (${panel.status.ms} ms)` : ""}`
    : ""
  lines.push(
    `Status: ${panelStatus(panel).slice(2)}${panel.status.server ? ` to ${panel.status.server}` : ""}${checked}`,
  )
  if (panel.status.error) {
    lines.push(`✗ ${panel.status.error.stage}: ${panel.status.error.message}`)
    if (panel.status.error.fix) lines.push(`Fix: ${panel.status.error.fix}`)
  }
  lines.push(`Leaves the computer: ${panel.leaves}`)
  lines.push(
    [
      `Template: ${panel.template?.name ?? "Custom"}`,
      panel.template?.scope ? `scope: ${panel.template.scope}` : undefined,
      `encryption: ${panel.place !== "embedded" ? "n/a (on the server)" : panel.encryption === "os-keychain" ? "on (OS keychain)" : "off"}`,
      panel.retentionDays ? `kept ${panel.retentionDays} days` : "kept until removed",
    ]
      .filter(Boolean)
      .join(" · "),
  )
  if (panel.locked) lines.push("Set by your organisation")
  return lines
}

/** The panel as plain text, for a terminal: the title and status, then the lines under them. */
export function panelText(panel: Panel, now = Date.now()) {
  const pad = "          "
  return [`Storage   ${panelTitle(panel)}   ${panelStatus(panel)}`, ...panelLines(panel, now).map((line) => pad + line)]
}
