export * as MemoryExternal from "./external"

import crypto from "node:crypto"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { promisify } from "node:util"
import type { ConfigMemory } from "@opencode-ai/core/config/memory"
import { Global } from "@opencode-ai/core/global"
import type { Residency } from "@opencode-ai/core/residency"
import { AuditLog } from "@/audit/log"
import { ConfigMemoryBackend } from "@/config/memory-backend"
import type { MemoryBackend } from "./backend"
import { MemoryLifecycle } from "./lifecycle"
import { MemoryFailure } from "./failure"
import { MemoryStore } from "./store"

/**
 * Memory in an external database (XCOD-134): Neo4j, and PostgreSQL since XCOD-264. Memgraph is
 * accepted in config but refused when memory starts: it fails the contract tests (see the docs).
 *
 * - **The database is the ledger.** Cognee can put its graph in Neo4j, but its dataset records stay
 *   in a local SQLite file and its vectors in a local LanceDB, so a second machine pointed at the
 *   same Neo4j knows none of the first one's facts. Here each fact is one `:LunosMemoryFact` node
 *   holding the same record the embedded ledger holds (text, provenance, lifecycle) and a SHA-256
 *   of it, so every machine reads the same facts with the same provenance.
 * - **No embeddings, no extraction.** Recall is the database's own full-text index (Lucene), so
 *   nothing is computed on one machine that another would have to rebuild, and no model is called
 *   to remember a fact. There is no entity graph in external memory.
 * - **Scopes are namespaces.** Every node carries `ns`: `project:<hash of the repo's remote>` or
 *   `user:<hash of the user id>`. Every query filters on it in Cypher; nothing from another
 *   namespace is ever fetched.
 * - **Checked before connecting.** `gate()` refuses a missing jurisdiction, one the residency policy
 *   doesn't allow (recorded as `memory.denied`), a URL with credentials in it, and plain Bolt to a
 *   host that isn't this machine. The driver is only imported after that.
 */

export type Kind = "neo4j" | "postgres" | "memgraph"

export interface Settings {
  type: Kind
  url: string
  database?: string
  username?: string
  password?: string
  jurisdiction: string
  readOnly: boolean
  allowInsecure: boolean
  user?: string
}

/** A setting that can't work: named, with what to do. Never carries a credential. */
export class ConfigError extends Error {
  override name = "MemoryBackendConfig"
}

/** Refused by the residency policy. Recorded in the audit log as `memory.denied`. */
export class DeniedError extends Error {
  override name = "MemoryBackendDenied"
}

export class ReadOnlyError extends Error {
  override name = "MemoryReadOnly"
}

export const DOCS = ConfigMemoryBackend.DOCS

/** The backend block, or undefined for embedded memory. */
export function configured(memory: ConfigMemory.Info | undefined): ConfigMemory.Info["backend"] | undefined {
  const block = memory?.backend
  if (!block || (block.type ?? "embedded") === "embedded") return undefined
  return block
}

export function type(memory: ConfigMemory.Info | undefined): "embedded" | Kind {
  return (configured(memory)?.type as Kind | undefined) ?? "embedded"
}

export function readOnly(memory: ConfigMemory.Info | undefined) {
  return configured(memory)?.read_only === true
}

// Credentials are checked when config is loaded, on the text before substitution:
// `ConfigMemoryBackend.credentialProblems` in config/memory-backend.ts.
export const credentialProblems = ConfigMemoryBackend.credentialProblems

// ---------------------------------------------------------------------------------------------
// The checks that run before any connection.

const SCHEMES = new Set(["bolt", "bolt+s", "bolt+ssc", "neo4j", "neo4j+s", "neo4j+ssc"])
const POSTGRES_SCHEMES = new Set(["postgres", "postgresql"])

/** The jurisdiction a database on this computer declares (the Docker templates): nothing leaves it. */
export const LOCAL = "local"

// "EU-only" means the EU and the EEA (PO, 2026-10-14): the 27 member states plus Iceland, Liechtenstein
// and Norway. Switzerland and the UK are not in it.
const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO".split(" "))

/** "EU", "EU-DE" or an EU/EEA country code → eu; "US" or "US-xx" → us; anything else → other. */
export function region(jurisdiction: string): Residency.Policy["allow"][number] {
  const head = jurisdiction.trim().toUpperCase().split("-")[0]
  if (head === "EU" || EU.has(head)) return "eu"
  if (head === "US") return "us"
  return "other"
}

export function loopback(host: string) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (bare === "localhost" || bare.endsWith(".localhost")) return true
  if (net.isIPv4(bare)) return bare.startsWith("127.")
  if (net.isIPv6(bare)) return bare === "::1"
  return false
}

/** Refusals already written to the audit log by this process. */
const denied = new Set<string>()

export interface Checked {
  settings: Settings
  host: string
  tls: "verified" | "unverified" | "none"
  warnings: string[]
}

/**
 * Everything that must hold before a socket is opened, in order: the type is supported, the URL is
 * well-formed and carries no credentials, a jurisdiction is declared, the connection is encrypted
 * (or to this machine, or explicitly allowed not to be), and the residency policy allows the
 * jurisdiction. A denial is written to the audit log naming `memory.backend`.
 */
export function gate(input: {
  memory: ConfigMemory.Info | undefined
  residency: Residency.Resolved | undefined
}): Checked {
  const block = configured(input.memory)
  if (!block) throw new ConfigError("memory is stored on this computer; there is no team database to connect to")
  const kind = block.type as Kind
  if (kind === "memgraph")
    throw new ConfigError(
      'memory.backend.type "memgraph" is not supported yet: it fails the external memory contract tests. Use "neo4j" or "postgres", or keep memory on this computer',
    )
  if (input.memory?.encryption === "os-keychain")
    throw new ConfigError(
      'memory.encryption "os-keychain" can\'t be used with an external memory database: the key is in one person\'s keychain, and the database is shared. Encrypt the database at rest on the server, and set memory.encryption to "off"',
    )
  const example = kind === "postgres" ? "postgres://db.internal:5432/lunos" : "bolt+s://graph.internal:7687"
  if (!block.url) throw new ConfigError(`memory.backend.url is required for a ${kind} backend (see ${DOCS})`)
  let url: URL
  try {
    url = new URL(block.url)
  } catch {
    throw new ConfigError(`memory.backend.url is not a valid URL (expected e.g. ${example})`)
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase()
  if (kind === "postgres" ? !POSTGRES_SCHEMES.has(scheme) : !SCHEMES.has(scheme))
    throw new ConfigError(
      kind === "postgres"
        ? `memory.backend.url must use postgres:// or postgresql:// for a postgres backend; got ${scheme}://`
        : `memory.backend.url must use bolt+s://, neo4j+s:// (TLS) or, to this machine, bolt:// / neo4j://; got ${scheme}://`,
    )
  if (url.username || url.password)
    throw new ConfigError(
      "memory.backend.url must not contain credentials; use memory.backend.username and password as {env:} or {file:} references",
    )
  const host = url.hostname
  const jurisdiction = block.jurisdiction?.trim()
  if (!jurisdiction)
    throw new ConfigError(
      `memory.backend.jurisdiction is required for an external memory database: say where it runs, e.g. "EU-DE", or "local" for a database on this computer (see ${DOCS})`,
    )
  const local = jurisdiction.toLowerCase() === LOCAL
  if (local && !loopback(host))
    throw new ConfigError(
      `memory.backend.jurisdiction "local" is only for a database on this computer (localhost), and ${host} isn't. Say where it runs, e.g. "EU-DE"`,
    )
  if (!local && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(jurisdiction))
    throw new ConfigError(`memory.backend.jurisdiction should look like "EU-DE", "EU" or "US"; got "${jurisdiction}"`)
  const warnings: string[] = []
  const tls =
    kind === "postgres"
      ? postgresTls(url)
      : scheme.endsWith("+s")
        ? "verified"
        : scheme.endsWith("+ssc")
          ? "unverified"
          : "none"
  const shown =
    kind === "postgres" ? `${scheme}:// (sslmode ${url.searchParams.get("sslmode") ?? "unset"})` : `${scheme}://`
  if (tls === "unverified")
    warnings.push(
      `memory.backend.url uses ${shown}: the connection is encrypted, but the server's certificate is not fully verified`,
    )
  if (tls === "none" && !loopback(host)) {
    if (!block.allow_insecure)
      throw new ConfigError(
        kind === "postgres"
          ? `memory.backend.url is unencrypted (${shown}) to ${host}, which isn't this machine: facts and credentials would cross the network unencrypted. Remove sslmode or use sslmode=verify-full, or set memory.backend.allow_insecure: true to accept that`
          : `memory.backend.url is plain ${scheme}:// to ${host}, which isn't this machine: facts and credentials would cross the network unencrypted. Use ${scheme}+s://, or set memory.backend.allow_insecure: true to accept that`,
      )
    warnings.push(`memory.backend.allow_insecure is set: facts and credentials go to ${host} unencrypted (${shown})`)
  }
  const claimed = region(jurisdiction)
  const residency = input.residency
  // A database on this computer is where the residency policy already allows the data to be.
  if (!local && residency && residency.enforce !== false && !residency.policy.allow.includes(claimed)) {
    const reason = `memory.backend declares jurisdiction "${jurisdiction}" (${claimed}), which the residency policy does not allow (${residency.policy.allow.join(", ")})`
    // Once per process for the same refusal: status, recall and each tool call all check again.
    const key = `${host}\n${jurisdiction}\n${residency.policy.allow.join(",")}`
    if (!denied.has(key)) {
      denied.add(key)
      AuditLog.emit("memory.denied", { setting: "memory.backend", host, jurisdiction, region: claimed, reason })
    }
    throw new DeniedError(`Blocked by data-residency policy. ${reason}. Memory was not started and nothing was sent.`)
  }
  return {
    settings: {
      type: kind,
      url: block.url,
      database: block.database || undefined,
      username: block.username || undefined,
      password: block.password || undefined,
      jurisdiction,
      readOnly: block.read_only === true,
      allowInsecure: block.allow_insecure === true,
      user: block.user || undefined,
    },
    host,
    tls,
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// Identities. Never a local path: the project is its git remote, the user a random or configured id.

const run = promisify(execFile)

/** One spelling for the same remote: scp, ssh and https forms of a repository hash the same. */
export function normalizeRemote(remote: string) {
  let value = remote.trim()
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(value)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `ssh://${scp[1]}/${scp[2]}`
  let host = ""
  let pathname = value
  try {
    const url = new URL(value)
    host = url.hostname.toLowerCase()
    pathname = url.pathname
  } catch {
    // Not a URL (a local path remote): used as it is, and still only hashed.
  }
  pathname = pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "")
  return host ? `${host}/${pathname}` : pathname
}

function hash(label: string, value: string) {
  return crypto.createHash("sha256").update(`${label}\n${value}`).digest("hex")
}

export async function projectID(worktree: string) {
  const remote = await run("git", ["-C", worktree, "remote", "get-url", "origin"])
    .then((out) => out.stdout.trim())
    .catch(async () => {
      const names = await run("git", ["-C", worktree, "remote"])
        .then((out) => out.stdout.split("\n").filter(Boolean))
        .catch(() => [] as string[])
      if (!names.length) return ""
      return run("git", ["-C", worktree, "remote", "get-url", names[0]]).then((out) => out.stdout.trim())
    })
  if (!remote)
    throw new ConfigError(
      "Project memory in an external database is keyed by the repository's git remote, and this project has none. Add one (git remote add origin <url>), or keep project memory on this computer",
    )
  return hash("lunos-project", normalizeRemote(remote))
}

export async function userID(configured: string | undefined) {
  if (configured) return hash("lunos-user", configured)
  const file = path.join(Global.Path.data, "memory", "user.id")
  const existing = (await fs.readFile(file, "utf8").catch(() => "")).trim()
  if (existing) return hash("lunos-user", existing)
  const id = crypto.randomUUID()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, id + "\n", { mode: 0o600, flag: "wx" }).catch(() => {})
  return hash("lunos-user", (await fs.readFile(file, "utf8")).trim())
}

export async function namespace(scope: MemoryStore.Scope, input: { worktree: string; user?: string }) {
  return scope === "project" ? `project:${await projectID(input.worktree)}` : `user:${await userID(input.user)}`
}

// ---------------------------------------------------------------------------------------------
// The backend, the same for every database.

export interface Health {
  facts: number
  lastWrite?: string
  problems: MemoryStore.Problem[]
  server: string
}

export interface External extends MemoryBackend.Backend {
  readonly kind: Kind
  readonly namespace: string
  readonly readOnly: boolean
  /** Delete every fact in this namespace. Returns how many. */
  purge(): Promise<number>
  /** Rewrite every fact in this namespace (link, reseal). Recomputes each hash. */
  rewrite(change: (facts: MemoryStore.Fact[]) => MemoryStore.Fact[]): Promise<void>
  health(): Promise<Health>
}

const LABEL = "LunosMemoryFact"
const TEXT_INDEX = "lunos_memory_fact_text"

/** The stored record: a fact as the embedded ledger holds it, minus runtime fields. */
function recordOf(fact: MemoryStore.Fact) {
  const { detached: _d, quarantined: _q, ...rest } = fact
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
}

type Row = { id: string; ns: string; text: string; record: string; hash: string; written?: string }

function factOf(row: Row, ns: string): { fact: MemoryStore.Fact; problem?: string } {
  let record: Record<string, unknown> | undefined
  try {
    record = JSON.parse(row.record)
  } catch {}
  const fallback: MemoryStore.Fact = {
    id: row.id,
    datasetID: "",
    text: row.text ?? "",
    provenance: { sessionID: "", agent: "", source: "", date: "" },
  }
  if (!record || typeof record !== "object")
    return { fact: { ...fallback, quarantined: "unreadable record" }, problem: "unreadable record" }
  const fact = record as unknown as MemoryStore.Fact
  const problem =
    MemoryStore.hashOf(record) !== row.hash
      ? "the record doesn't match its integrity hash"
      : fact.id !== row.id || fact.text !== row.text || row.ns !== ns
        ? "the node's id, text or namespace doesn't match its record"
        : undefined
  return problem ? { fact: { ...fact, quarantined: problem }, problem } : { fact }
}

/** Lucene query from free text: words OR'd, every special character dropped. */
export function textQuery(query: string) {
  return queryWords(query).join(" OR ")
}

function overlap(query: string, text: string) {
  const want = new Set(MemoryLifecycle.words(query))
  if (!want.size) return 0
  const have = new Set(MemoryLifecycle.words(text))
  let shared = 0
  for (const word of want) if (have.has(word)) shared++
  return shared / want.size
}

/**
 * What a database has to do for external memory. Everything else (dedupe, limits, lifecycle,
 * integrity) is the same for every vendor, in `open()`, so the contract tests hold for each.
 */
export interface Driver {
  /** Every row in a namespace, oldest write first. */
  rows(ns: string): Promise<Row[]>
  /** Full-text matches for these words (any of them), best first; `score` is higher-is-closer. */
  search(ns: string, words: string[], limit: number): Promise<(Row & { score: number })[]>
  insert(props: Props): Promise<void>
  update(ns: string, id: string, props: Props): Promise<void>
  remove(ns: string, ids: string[]): Promise<number>
  removeAll(ns: string): Promise<number>
  lastWrite(ns: string): Promise<string | undefined>
  server(): Promise<string>
  close(): Promise<void>
}

type Props = {
  id: string
  ns: string
  scope: string
  text: string
  status: string
  record: string
  hash: string
  written: string
}

type OpenInput = {
  checked: Checked
  scope: MemoryStore.Scope
  worktree: string
  limits: MemoryBackend.Limits
  retention?: MemoryLifecycle.Retention
  /** For tests and the connection probe: a namespace to use instead of the project's or user's. */
  namespace?: string
}

/** The words a full-text query searches for: lowercased, punctuation and query syntax dropped. */
export function queryWords(query: string) {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(" ")
        .filter((word) => word.length > 1 && !["and", "or", "not", "to"].includes(word)),
    ),
  ].slice(0, 64)
}

async function connect(checked: Checked): Promise<Driver> {
  if (checked.settings.type === "postgres") return postgresDriver(checked)
  return neo4jDriver(checked)
}

/** Open external memory for one scope, on whichever database `checked` names. */
export async function open(input: OpenInput): Promise<External> {
  const { settings } = input.checked
  const ns = input.namespace ?? (await namespace(input.scope, { worktree: input.worktree, user: settings.user }))
  const driver = await connect(input.checked)
  return store(input, ns, driver)
}

/** @deprecated kept for callers from XCOD-134; use open(). */
export const neo4j = open

function store(input: OpenInput, ns: string, driver: Driver): External {
  const { settings } = input.checked
  const policy = input.retention ?? { graceDays: MemoryLifecycle.DEFAULT_GRACE_DAYS }
  const { limits } = input
  const writable = () => {
    if (settings.readOnly) throw new ReadOnlyError("memory.backend.read_only is set: external memory is recall-only")
  }
  const all = async () => (await driver.rows(ns)).map((row) => factOf(row, ns))
  const facts = async () => (await all()).map((item) => item.fact)

  const put = async (fact: MemoryStore.Fact, create: boolean) => {
    writable()
    const record = recordOf(fact)
    const props: Props = {
      id: fact.id,
      ns,
      scope: input.scope,
      text: fact.text,
      status: fact.status ?? "active",
      record: JSON.stringify(record),
      hash: MemoryStore.hashOf(record),
      written: new Date().toISOString(),
    }
    if (create) await driver.insert(props)
    else await driver.update(ns, fact.id, props)
  }

  return {
    kind: settings.type,
    namespace: ns,
    readOnly: settings.readOnly,
    async remember(text, provenance, extra) {
      writable()
      const trimmed = text.trim()
      if (!trimmed) throw new Error("Nothing to remember")
      if (trimmed.length > limits.maxFactChars)
        throw new Error(
          `A fact can be at most ${limits.maxFactChars} characters (memory.limits.max_fact_chars); this one is ${trimmed.length}`,
        )
      const existing = await facts()
      // Only a fact that is still recalled counts as the same: re-remembering the text of an
      // outdated or expired fact stores it again, active.
      const at = MemoryLifecycle.now()
      const same = existing.find(
        (fact) => fact.text === trimmed && !fact.quarantined && MemoryLifecycle.recallable(fact, policy, at),
      )
      if (same) return same
      if (existing.length >= limits.maxFacts)
        throw new Error(
          `Memory holds ${existing.length} facts, the most allowed (memory.limits.max_facts). Forget some before remembering more`,
        )
      const { id: wanted, ...rest } = extra ?? {}
      const fact: MemoryStore.Fact = {
        id: wanted && !existing.some((item) => item.id === wanted) ? wanted : crypto.randomUUID(),
        datasetID: "",
        text: trimmed,
        provenance,
      }
      for (const [key, value] of Object.entries(rest))
        if (value !== undefined) (fact as unknown as Record<string, unknown>)[key] = value
      await put(fact, true)
      return fact
    },
    async recall(query, limit, options) {
      const at = MemoryLifecycle.now()
      const out: MemoryBackend.Recalled[] = []
      const words = queryWords(query)
      if (words.length) {
        for (const row of await driver.search(ns, words, limit + 50)) {
          const { fact, problem } = factOf(row, ns)
          if (problem || !MemoryLifecycle.recallable(fact, policy, at)) continue
          // The database's score is higher-is-closer; recall sorts lower-is-closer.
          out.push({ fact, score: 1 / (1 + row.score) })
          if (out.length >= limit) break
        }
      }
      if (options?.history) {
        const past = (await facts())
          .filter((fact) => !fact.quarantined && MemoryLifecycle.state(fact, policy, at) === "outdated")
          .map((fact) => ({ fact, score: 2 - overlap(query, fact.text) }))
          .filter((item) => item.score < 2)
          .toSorted((a, b) => a.score - b.score)
          .slice(0, limit)
        out.push(...past)
      }
      return { facts: out, graph: "" }
    },
    async forget(id) {
      writable()
      return (await driver.remove(ns, [id])) > 0
    },
    async outdate(id, change) {
      const current = (await facts()).find((item) => item.id === id && !item.quarantined)
      if (!current || !MemoryStore.isActive(current)) return undefined
      const updated: MemoryStore.Fact = {
        ...current,
        status: "outdated",
        invalid_at: change.at.toISOString(),
        ...(change.by ? { replaced_by: change.by } : {}),
      }
      await put(updated, false)
      if (change.by) {
        const by = (await facts()).find((item) => item.id === change.by && !item.quarantined)
        if (by) await put({ ...by, replaces: id }, false)
      }
      return updated
    },
    async sweep(at) {
      const expired: MemoryStore.Fact[] = []
      const purged: MemoryStore.Fact[] = []
      if (settings.readOnly) return { expired, purged }
      for (const fact of await facts()) {
        const state = MemoryLifecycle.state(fact, policy, at)
        if (state === "purge") purged.push(fact)
        else if (state === "expired") expired.push(fact)
      }
      if (purged.length)
        await driver.remove(
          ns,
          purged.map((fact) => fact.id),
        )
      return { expired, purged }
    },
    list: facts,
    async graph() {
      // External memory holds facts only: there is no entity graph to export.
      return { nodes: [], edges: [] }
    },
    async purge() {
      writable()
      return driver.removeAll(ns)
    },
    async rewrite(change) {
      const before = await facts()
      const after = change(before)
      const known = new Set(before.map((fact) => fact.id))
      for (const fact of after) if (known.has(fact.id)) await put({ ...fact, quarantined: undefined }, false)
    },
    async health() {
      const items = await all()
      return {
        facts: items.length,
        lastWrite: await driver.lastWrite(ns),
        problems: items.flatMap((item, index) =>
          item.problem ? [{ line: index + 1, id: item.fact.id, reason: item.problem }] : [],
        ),
        server: `${await driver.server()} at ${input.checked.host}`,
      }
    },
    close: () => driver.close(),
  }
}

// ---------------------------------------------------------------------------------------------
// Neo4j, over Bolt.

async function neo4jDriver(checked: Checked): Promise<Driver> {
  const { settings } = checked
  // Imported only now: nothing before this opened a socket.
  const lib = (await import("neo4j-driver")).default
  const auth = settings.username ? lib.auth.basic(settings.username, settings.password ?? "") : undefined
  const driver = lib.driver(settings.url, auth, { disableLosslessIntegers: true, logging: undefined })
  const database = settings.database
  const read = (query: string, params: Record<string, unknown> = {}) =>
    driver.executeQuery(query, params, { database, routing: lib.routing.READ })
  const write = (query: string, params: Record<string, unknown> = {}) =>
    driver.executeQuery(query, params, { database, routing: lib.routing.WRITE })
  try {
    await driver.verifyConnectivity({ database })
    if (!settings.readOnly) {
      await write(`CREATE CONSTRAINT lunos_memory_fact_id IF NOT EXISTS FOR (f:${LABEL}) REQUIRE f.id IS UNIQUE`)
      await write(`CREATE INDEX lunos_memory_fact_ns IF NOT EXISTS FOR (f:${LABEL}) ON (f.ns)`)
      // The English analyzer drops stop words and stems, so "who owns the invoices table" ranks
      // the fact about invoices first rather than every fact that says "the".
      await write(
        `CREATE FULLTEXT INDEX ${TEXT_INDEX} IF NOT EXISTS FOR (f:${LABEL}) ON EACH [f.text] OPTIONS {indexConfig: {\`fulltext.analyzer\`: 'english'}}`,
      )
      await write(`CALL db.awaitIndexes(60)`)
    }
  } catch (error) {
    await driver.close().catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not connect to the ${settings.type} memory database at ${checked.host}: ${message}`)
  }
  const count = (result: { records: { get(key: string): unknown }[] }) => Number(result.records[0]?.get("n") ?? 0)
  return {
    async rows(ns) {
      const result = await read(
        `MATCH (f:${LABEL} {ns: $ns}) RETURN f.id AS id, f.ns AS ns, f.text AS text, f.record AS record, f.hash AS hash, f.written AS written ORDER BY f.written, f.id`,
        { ns },
      )
      return result.records.map((record) => record.toObject() as Row)
    },
    async search(ns, words, limit) {
      const result = await read(
        `CALL db.index.fulltext.queryNodes($index, $q) YIELD node, score
         WHERE node.ns = $ns AND node.status = 'active'
         RETURN node.id AS id, node.ns AS ns, node.text AS text, node.record AS record, node.hash AS hash, score
         ORDER BY score DESC LIMIT $limit`,
        { index: TEXT_INDEX, q: words.join(" OR "), ns, limit: lib.int(limit) },
      )
      return result.records.map((record) => record.toObject() as Row & { score: number })
    },
    async insert(props) {
      await write(`CREATE (f:${LABEL}) SET f = $props`, { props })
    },
    async update(ns, id, props) {
      await write(`MATCH (f:${LABEL} {ns: $ns, id: $id}) SET f = $props`, { ns, id, props })
    },
    async remove(ns, ids) {
      return count(
        await write(`MATCH (f:${LABEL} {ns: $ns}) WHERE f.id IN $ids DETACH DELETE f RETURN count(*) AS n`, {
          ns,
          ids,
        }),
      )
    },
    async removeAll(ns) {
      return count(await write(`MATCH (f:${LABEL} {ns: $ns}) DETACH DELETE f RETURN count(*) AS n`, { ns }))
    },
    async lastWrite(ns) {
      const result = await read(`MATCH (f:${LABEL} {ns: $ns}) RETURN max(f.written) AS last`, { ns })
      return (result.records[0]?.get("last") as string | null) ?? undefined
    },
    async server() {
      const info = await driver.getServerInfo({ database })
      return info.agent ?? settings.type
    },
    async close() {
      await driver.close().catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL (XCOD-264), through Bun's built-in client: no new dependency. One row per fact, the
// same record and hash as a Neo4j node; search is PostgreSQL's own full-text search.

const TABLE = "lunos_memory_fact"

/** `postgres://` TLS from `sslmode`: verify-full checks the certificate and host; require/verify-ca don't fully. */
export function postgresTls(url: URL): Checked["tls"] {
  const mode = url.searchParams.get("sslmode")?.toLowerCase()
  if (mode === "verify-full") return "verified"
  if (mode === "require" || mode === "verify-ca") return "unverified"
  if (mode === "disable" || mode === "allow" || mode === "prefer") return "none"
  // No sslmode: TLS with a verified certificate, except to this computer.
  return loopback(url.hostname) ? "none" : "verified"
}

type SQL = {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>
  begin<T>(run: (tx: SQL) => Promise<T>): Promise<T>
  close(options?: { timeout?: number }): Promise<void>
}

async function postgresDriver(checked: Checked): Promise<Driver> {
  const { settings } = checked
  // Bun's built-in client, read from the global so bundles that can't import "bun" still load this file.
  const Client = (globalThis as { Bun?: { SQL?: new (options: Record<string, unknown>) => SQL } }).Bun?.SQL
  if (!Client) throw new Error("PostgreSQL memory needs the Lunos binary (Bun's built-in PostgreSQL client)")
  const url = new URL(settings.url)
  const tls = checked.tls
  url.search = ""
  const sql = new Client({
    url: url.toString(),
    username: settings.username,
    password: settings.password ?? "",
    tls: tls === "none" ? false : tls === "verified" ? true : { rejectUnauthorized: false },
    max: 4,
    idleTimeout: 30,
    connectionTimeout: 15,
  })
  try {
    await sql.unsafe("SELECT 1")
    if (!settings.readOnly)
      // Two machines starting at once would race on CREATE TABLE IF NOT EXISTS; the lock serialises them.
      await sql.begin(async (tx) => {
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('${TABLE}'))`)
        await tx.unsafe(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (
             id text PRIMARY KEY,
             ns text NOT NULL,
             scope text NOT NULL,
             text text NOT NULL,
             status text NOT NULL,
             record text NOT NULL,
             hash text NOT NULL,
             written text NOT NULL,
             tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
           )`,
        )
        await tx.unsafe(`CREATE INDEX IF NOT EXISTS ${TABLE}_ns ON ${TABLE} (ns)`)
        await tx.unsafe(`CREATE INDEX IF NOT EXISTS ${TABLE}_tsv ON ${TABLE} USING GIN (tsv)`)
      })
  } catch (error) {
    await sql.close({ timeout: 0 }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not connect to the postgres memory database at ${checked.host}: ${message}`)
  }
  const columns = "id, ns, text, record, hash, written"
  return {
    async rows(ns) {
      return (await sql.unsafe(`SELECT ${columns} FROM ${TABLE} WHERE ns = $1 ORDER BY written, id`, [ns])) as Row[]
    },
    async search(ns, words, limit) {
      // Any of the words, like Neo4j's OR'd Lucene query; the English config drops stop words and stems.
      const rows = await sql.unsafe(
        `SELECT ${columns}, ts_rank(tsv, q) AS score
         FROM ${TABLE}, to_tsquery('english', $2) q
         WHERE ns = $1 AND status = 'active' AND tsv @@ q
         ORDER BY score DESC, id LIMIT $3`,
        [ns, words.join(" | "), limit],
      )
      return rows.map((row) => ({ ...(row as Row), score: Number(row.score) }))
    },
    async insert(props) {
      await sql.unsafe(
        `INSERT INTO ${TABLE} (id, ns, scope, text, status, record, hash, written) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [props.id, props.ns, props.scope, props.text, props.status, props.record, props.hash, props.written],
      )
    },
    async update(ns, id, props) {
      await sql.unsafe(
        `UPDATE ${TABLE} SET scope = $3, text = $4, status = $5, record = $6, hash = $7, written = $8 WHERE ns = $1 AND id = $2`,
        [ns, id, props.scope, props.text, props.status, props.record, props.hash, props.written],
      )
    },
    async remove(ns, ids) {
      // One text parameter split on the unit separator: the client binds strings, not arrays.
      const rows = await sql.unsafe(
        `DELETE FROM ${TABLE} WHERE ns = $1 AND id = ANY(string_to_array($2::text, chr(31))) RETURNING id`,
        [ns, ids.join("\x1f")],
      )
      return rows.length
    },
    async removeAll(ns) {
      return (await sql.unsafe(`DELETE FROM ${TABLE} WHERE ns = $1 RETURNING id`, [ns])).length
    },
    async lastWrite(ns) {
      const rows = await sql.unsafe(`SELECT max(written) AS last FROM ${TABLE} WHERE ns = $1`, [ns])
      return (rows[0]?.last as string | null) ?? undefined
    },
    async server() {
      const rows = await sql.unsafe("SHOW server_version")
      return `PostgreSQL ${String(rows[0]?.server_version ?? "")}`.trim()
    },
    async close() {
      await sql.close({ timeout: 5 }).catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The setup wizard's "Test connection" (XCOD-264): connect, write, read and delete a probe, in a
// namespace of its own so it never touches a real fact. A failure is described through XCOD-263's
// MemoryFailure: a reason that is never empty, with keys masked, and its fix when the probe's own
// stage-specific ones don't apply.

export type ProbeStage = "settings" | "residency" | "connect" | "write" | "read" | "delete"
export type ProbeError = { type: string; message: string; stage: ProbeStage; fix?: string }
export type ProbeResult =
  | { ok: true; ms: number; server: string; warnings: string[] }
  | { ok: false; error: ProbeError }

/** What to do about a probe failure, by stage and message. */
export function probeFix(stage: ProbeStage, message: string): string | undefined {
  if (stage === "residency") return "Pick a database in a region your residency policy allows."
  if (stage === "settings") return `Fix the setting named above (see ${DOCS}).`
  if (/ECONNREFUSED|connection refused|ServiceUnavailable|Failed to connect/i.test(message))
    return "Nothing answered at that address: check the URL and port, and that the database is running."
  if (/password authentication|authentication failure|Unauthorized|credentials/i.test(message))
    return "The user or password was refused: check the environment variables the config refers to."
  if (/certificate|self[- ]signed|TLS|SSL/i.test(message))
    return "The TLS connection failed: check the server's certificate, or the URL's TLS setting."
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return "That host name doesn't resolve: check the URL."
  if (/permission denied|read_only|AccessMode|not allowed/i.test(message))
    return "The user can connect but not write: grant it write access, or use a read-only setup."
  return undefined
}

export async function probe(input: {
  memory: ConfigMemory.Info | undefined
  residency: Residency.Resolved | undefined
}): Promise<ProbeResult> {
  const fail = (stage: ProbeStage, error: unknown): ProbeResult => {
    const type = error instanceof DeniedError ? "residency" : error instanceof ConfigError ? "config" : stage
    const info: MemoryFailure.Info = {
      type: error instanceof Error ? error.name : type,
      message: MemoryFailure.summary(error),
      cause: [],
      stage,
      sampling: [],
    }
    const message = MemoryFailure.reason(info)
    const general = MemoryFailure.fix(info)
    const fix = probeFix(stage, message) ?? (general && general.kind !== "unknown" ? general.text : undefined)
    return { ok: false, error: { type, message, stage, fix } }
  }
  let checked: Checked
  try {
    checked = gate(input)
  } catch (error) {
    return fail(error instanceof DeniedError ? "residency" : "settings", error)
  }
  const started = Date.now()
  let driver: Driver
  try {
    driver = await connect(checked)
  } catch (error) {
    return fail("connect", error)
  }
  const ns = `probe:${crypto.randomUUID()}`
  const id = crypto.randomUUID()
  let stage: ProbeStage = "write"
  try {
    if (checked.settings.readOnly) {
      stage = "read"
      await driver.rows(ns)
    } else {
      const record = { id, text: "Lunos connection probe" }
      await driver.insert({
        id,
        ns,
        scope: "probe",
        text: record.text,
        status: "active",
        record: JSON.stringify(record),
        hash: MemoryStore.hashOf(record),
        written: new Date().toISOString(),
      })
      stage = "read"
      if (!(await driver.rows(ns)).some((row) => row.id === id))
        throw new Error("the probe was written but not read back")
      stage = "delete"
      if ((await driver.remove(ns, [id])) !== 1) throw new Error("the probe could not be deleted")
    }
    return {
      ok: true,
      ms: Date.now() - started,
      server: `${await driver.server()} at ${checked.host}`,
      warnings: checked.warnings,
    }
  } catch (error) {
    if (stage !== "delete") await driver.remove(ns, [id]).catch(() => {})
    return fail(stage, error)
  } finally {
    await driver.close()
  }
}
