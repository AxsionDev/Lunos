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
import { MemoryStore } from "./store"

/**
 * Memory in an external graph database (XCOD-134). Neo4j first; Memgraph is accepted in config but
 * refused when memory starts, since it hasn't been run against.
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

export type Kind = "neo4j" | "memgraph"

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

const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "))

/** "EU", "EU-DE" or an EU country code → eu; "US" or "US-xx" → us; anything else → other. */
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
  if (!block) throw new ConfigError("memory.backend is embedded; there is no external database to connect to")
  const kind = block.type as Kind
  if (kind === "memgraph")
    throw new ConfigError(
      'memory.backend.type "memgraph" is not supported yet: only "neo4j" has been run against. Use "neo4j", or "embedded"',
    )
  if (input.memory?.encryption === "os-keychain")
    throw new ConfigError(
      'memory.encryption "os-keychain" can\'t be used with an external memory database: the key is in one person\'s keychain, and the database is shared. Encrypt the database at rest on the server, and set memory.encryption to "off"',
    )
  if (!block.url) throw new ConfigError(`memory.backend.url is required for a ${kind} backend (see ${DOCS})`)
  let url: URL
  try {
    url = new URL(block.url)
  } catch {
    throw new ConfigError(`memory.backend.url is not a valid URL (expected e.g. bolt+s://graph.internal:7687)`)
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase()
  if (!SCHEMES.has(scheme))
    throw new ConfigError(
      `memory.backend.url must use bolt+s://, neo4j+s:// (TLS) or, to this machine, bolt:// / neo4j://; got ${scheme}://`,
    )
  if (url.username || url.password)
    throw new ConfigError(
      "memory.backend.url must not contain credentials; use memory.backend.username and password as {env:} or {file:} references",
    )
  const jurisdiction = block.jurisdiction?.trim()
  if (!jurisdiction)
    throw new ConfigError(
      `memory.backend.jurisdiction is required for an external memory database: say where it runs, e.g. "EU-DE" (see ${DOCS})`,
    )
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(jurisdiction))
    throw new ConfigError(`memory.backend.jurisdiction should look like "EU-DE", "EU" or "US"; got "${jurisdiction}"`)
  const host = url.hostname
  const warnings: string[] = []
  const tls = scheme.endsWith("+s") ? "verified" : scheme.endsWith("+ssc") ? "unverified" : "none"
  if (tls === "unverified")
    warnings.push(
      `memory.backend.url uses ${scheme}://: the connection is encrypted, but the server's certificate is not verified`,
    )
  if (tls === "none" && !loopback(host)) {
    if (!block.allow_insecure)
      throw new ConfigError(
        `memory.backend.url is plain ${scheme}:// to ${host}, which isn't this machine: facts and credentials would cross the network unencrypted. Use ${scheme}+s://, or set memory.backend.allow_insecure: true to accept that`,
      )
    warnings.push(
      `memory.backend.allow_insecure is set: facts and credentials go to ${host} unencrypted (${scheme}://)`,
    )
  }
  const claimed = region(jurisdiction)
  const residency = input.residency
  if (residency && residency.enforce !== false && !residency.policy.allow.includes(claimed)) {
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
      "Project memory in an external database is keyed by the repository's git remote, and this project has none. Add one (git remote add origin <url>), or keep project memory embedded",
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
// The Neo4j backend.

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
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(" ")
        .filter((word) => word.length > 1 && !["and", "or", "not", "to"].includes(word)),
    ),
  ].slice(0, 64)
  return words.join(" OR ")
}

function overlap(query: string, text: string) {
  const want = new Set(MemoryLifecycle.words(query))
  if (!want.size) return 0
  const have = new Set(MemoryLifecycle.words(text))
  let shared = 0
  for (const word of want) if (have.has(word)) shared++
  return shared / want.size
}

export async function neo4j(input: {
  checked: Checked
  scope: MemoryStore.Scope
  worktree: string
  limits: MemoryBackend.Limits
  retention?: MemoryLifecycle.Retention
  /** For tests: a namespace to use instead of the project's or user's. */
  namespace?: string
}): Promise<External> {
  const { settings } = input.checked
  const ns = input.namespace ?? (await namespace(input.scope, { worktree: input.worktree, user: settings.user }))
  const policy = input.retention ?? { graceDays: MemoryLifecycle.DEFAULT_GRACE_DAYS }
  const { limits } = input
  // Imported only now: nothing above opened a socket.
  const lib = (await import("neo4j-driver")).default
  const auth = settings.username ? lib.auth.basic(settings.username, settings.password ?? "") : undefined
  const driver = lib.driver(settings.url, auth, { disableLosslessIntegers: true, logging: undefined })
  const database = settings.database
  const read = (query: string, params: Record<string, unknown> = {}) =>
    driver.executeQuery(query, params, { database, routing: lib.routing.READ })
  const write = (query: string, params: Record<string, unknown> = {}) => {
    if (settings.readOnly) throw new ReadOnlyError("memory.backend.read_only is set: external memory is recall-only")
    return driver.executeQuery(query, params, { database, routing: lib.routing.WRITE })
  }
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
    throw new Error(`Could not connect to the ${settings.type} memory database at ${input.checked.host}: ${message}`)
  }

  const rows = async (where = "", params: Record<string, unknown> = {}) => {
    const result = await read(
      `MATCH (f:${LABEL} {ns: $ns}) ${where} RETURN f.id AS id, f.ns AS ns, f.text AS text, f.record AS record, f.hash AS hash, f.written AS written ORDER BY f.written, f.id`,
      { ns, ...params },
    )
    return result.records.map((record) => record.toObject() as Row)
  }
  const all = async () => (await rows()).map((row) => factOf(row, ns))
  const facts = async () => (await all()).map((item) => item.fact)

  const put = async (fact: MemoryStore.Fact, create: boolean) => {
    const record = recordOf(fact)
    const props = {
      id: fact.id,
      ns,
      scope: input.scope,
      text: fact.text,
      status: fact.status ?? "active",
      record: JSON.stringify(record),
      hash: MemoryStore.hashOf(record),
      written: new Date().toISOString(),
    }
    if (create) await write(`CREATE (f:${LABEL}) SET f = $props`, { props })
    else await write(`MATCH (f:${LABEL} {ns: $ns, id: $id}) SET f = $props`, { ns, id: fact.id, props })
  }

  const backend: External = {
    kind: settings.type,
    namespace: ns,
    readOnly: settings.readOnly,
    async remember(text, provenance, extra) {
      if (settings.readOnly) throw new ReadOnlyError("memory.backend.read_only is set: external memory is recall-only")
      const trimmed = text.trim()
      if (!trimmed) throw new Error("Nothing to remember")
      if (trimmed.length > limits.maxFactChars)
        throw new Error(
          `A fact can be at most ${limits.maxFactChars} characters (memory.limits.max_fact_chars); this one is ${trimmed.length}`,
        )
      const existing = await facts()
      const same = existing.find((fact) => fact.text === trimmed && !fact.quarantined)
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
      const q = textQuery(query)
      if (q) {
        const result = await read(
          `CALL db.index.fulltext.queryNodes($index, $q) YIELD node, score
           WHERE node.ns = $ns AND node.status = 'active'
           RETURN node.id AS id, node.ns AS ns, node.text AS text, node.record AS record, node.hash AS hash, score
           ORDER BY score DESC LIMIT $limit`,
          { index: TEXT_INDEX, q, ns, limit: lib.int(limit + 50) },
        )
        for (const record of result.records) {
          const row = record.toObject() as Row & { score: number }
          const { fact, problem } = factOf(row, ns)
          if (problem || !MemoryLifecycle.recallable(fact, policy, at)) continue
          // Lucene's score is higher-is-closer; recall sorts lower-is-closer.
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
      const result = await write(`MATCH (f:${LABEL} {ns: $ns, id: $id}) DETACH DELETE f RETURN count(*) AS n`, {
        ns,
        id,
      })
      return Number(result.records[0]?.get("n") ?? 0) > 0
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
        await write(`MATCH (f:${LABEL} {ns: $ns}) WHERE f.id IN $ids DETACH DELETE f`, {
          ns,
          ids: purged.map((fact) => fact.id),
        })
      return { expired, purged }
    },
    list: facts,
    async graph() {
      // External memory holds facts only: there is no entity graph to export.
      return { nodes: [], edges: [] }
    },
    async purge() {
      const result = await write(`MATCH (f:${LABEL} {ns: $ns}) DETACH DELETE f RETURN count(*) AS n`, { ns })
      return Number(result.records[0]?.get("n") ?? 0)
    },
    async rewrite(change) {
      const before = await facts()
      const after = change(before)
      const known = new Set(before.map((fact) => fact.id))
      for (const fact of after) if (known.has(fact.id)) await put({ ...fact, quarantined: undefined }, false)
    },
    async health() {
      const items = await all()
      const written = await read(`MATCH (f:${LABEL} {ns: $ns}) RETURN max(f.written) AS last`, { ns })
      const info = await driver.getServerInfo({ database })
      return {
        facts: items.length,
        lastWrite: (written.records[0]?.get("last") as string | null) ?? undefined,
        problems: items.flatMap((item, index) =>
          item.problem ? [{ line: index + 1, id: item.fact.id, reason: item.problem }] : [],
        ),
        server: `${info.agent ?? settings.type} at ${input.checked.host}`,
      }
    },
    async close() {
      await driver.close().catch(() => {})
    },
  }
  return backend
}
