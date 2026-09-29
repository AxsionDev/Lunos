import net from "node:net"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ConfigMemorySource } from "@opencode-ai/core/config/memory-source"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import type { Residency } from "@opencode-ai/core/residency"
import { Context, Effect, Layer } from "effect"
import { AuditLog } from "@/audit/log"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { InstanceState } from "@/effect/instance-state"
import { MemoryBackend } from "../backend"
import { MemoryGuard } from "../guard"
import type { MemoryRecall } from "../recall"
import { MemorySourceGraph } from "./graph"
import { MemorySourceMcp } from "./mcp"

/**
 * External memory sources (XCOD-135, OWASP ASI06). A knowledge graph or an MCP memory server that
 * Lunos recalls from alongside its own memory, and never writes to. Everything here treats a
 * source as untrusted:
 *
 * - **Checked before it is contacted.** A source needs a `jurisdiction`, which the residency policy
 *   must allow, before its first query: a denied source is never connected to, and the denial is
 *   written to the audit log as `memory.source_denied`, naming the source.
 * - **Screened.** Each result goes through the same secret and instruction-pattern screens as a
 *   memory write or import (`MemoryGuard`). A result that fails is withheld, and only a count of
 *   withheld results reaches the model. A source can be `trusted` only in managed config, and then
 *   only skips the instruction-pattern screen.
 * - **Capped.** Each result is cut to `memory.limits.max_fact_chars`, and each source to its own
 *   `max_tokens`, inside the overall `memory.retrieval.max_tokens`.
 * - **Labelled, never stored.** Results go into the turn's `<memory>` block in a section named
 *   after the source; nothing a source returns is written to the local ledger. Keeping one means a
 *   person approving a `memory_remember` with the source as provenance.
 * - **Isolated.** Each query races its `timeout_ms` (default 2 s). A slow or failing source is
 *   skipped with a notice and never holds up the turn.
 * - **Off with memory.** The caller only asks when memory is on, and `/memory sources off <name>`
 *   turns one off for a session.
 */

export const DEFAULT_MAX_TOKENS = 500
export const DEFAULT_TIMEOUT_MS = 2000
/** Most results asked of a source per turn. */
export const LIMIT = 8

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const GRAPH_SCHEMES = new Set(["bolt", "bolt+s", "bolt+ssc", "neo4j", "neo4j+s", "neo4j+ssc"])
const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "))

/** "EU", "EU-DE" or an EU country code → eu; "US" or "US-xx" → us; anything else → other. */
export function region(jurisdiction: string): Residency.Policy["allow"][number] {
  const head = jurisdiction.trim().toUpperCase().split("-")[0]
  if (head === "EU" || EU.has(head)) return "eu"
  if (head === "US") return "us"
  return "other"
}

function loopback(host: string) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (bare === "localhost" || bare.endsWith(".localhost")) return true
  if (net.isIPv4(bare)) return bare.startsWith("127.")
  if (net.isIPv6(bare)) return bare === "::1"
  return false
}

type McpEntry = ConfigMCPV1.Info | { enabled: boolean }

/** Where a source runs, for the audit log: a host, or an MCP server's name. Never credentials. */
function where(source: ConfigMemorySource.Info, mcp: Record<string, McpEntry> | undefined) {
  if (source.type === "graph") {
    try {
      return new URL(source.url ?? "").host
    } catch {
      return "invalid"
    }
  }
  const entry = source.server ? mcp?.[source.server] : undefined
  if (entry && "type" in entry && entry.type === "remote") {
    try {
      return new URL(entry.url).host
    } catch {
      return "invalid"
    }
  }
  return `mcp:${source.server ?? "?"}`
}

/** What is wrong with a source's settings, if anything. Such a source is never queried. */
export function problem(source: ConfigMemorySource.Info, mcp: Record<string, McpEntry> | undefined) {
  if (!NAME.test(source.name))
    return `name "${source.name}" must be letters, digits, ".", "_" or "-" (it labels the source's results)`
  if (source.type === "graph") {
    if (!source.url) return "a graph source needs a url"
    let url: URL
    try {
      url = new URL(source.url)
    } catch {
      return `url "${source.url}" is not a URL`
    }
    const scheme = url.protocol.replace(/:$/, "")
    if (!GRAPH_SCHEMES.has(scheme))
      return `url must be bolt+s://, neo4j+s:// or, to this machine, bolt://; got ${scheme}://`
    if (url.username || url.password) return "url must not contain credentials; use username and password"
    if (!scheme.includes("+s") && !loopback(url.hostname))
      return `an unencrypted ${scheme}:// connection is only allowed to this machine; use ${scheme}+s://`
    return
  }
  if (!source.server) return 'an mcp source needs "server", the name of a server under "mcp"'
  if (!source.tool) return 'an mcp source needs "tool", the search tool to call'
  const entry = mcp?.[source.server]
  if (!entry || !("type" in entry)) return `no MCP server "${source.server}" is configured under "mcp"`
  return MemorySourceMcp.writeShaped(source.tool)
}

/**
 * Whether a source's `trusted: true` is honoured: only when managed config declares the same source,
 * the same way (type, url or server, and tool), as trusted. Matching the name alone would let a
 * project config point a managed source's name somewhere else and inherit its trust.
 */
export function managedTrust(source: ConfigMemorySource.Info, managed: readonly unknown[]) {
  if (source.trusted !== true) return false
  for (const doc of managed) {
    const list = (doc as { memory?: { sources?: unknown } } | undefined)?.memory?.sources
    if (!Array.isArray(list)) continue
    for (const item of list as Partial<ConfigMemorySource.Info>[]) {
      if (!item || item.trusted !== true || item.name !== source.name || item.type !== source.type) continue
      if (source.type === "graph" && item.url === source.url) return true
      if (source.type === "mcp" && item.server === source.server && item.tool === source.tool) return true
    }
  }
  return false
}

/** Every screen a source result must pass. Trusted sources skip only the instruction patterns. */
export function screen(text: string, trusted: boolean): string | undefined {
  if (/<\/?memory\b/i.test(text)) return "it contains memory markup"
  return MemoryGuard.secret(text) ?? (trusted ? undefined : MemoryGuard.instructions(text))
}

export type State = "ok" | "empty" | "disabled" | "off" | "misconfigured" | "denied" | "unavailable" | "not queried yet"

export interface Status {
  name: string
  type: "graph" | "mcp"
  host: string
  jurisdiction?: string
  trusted: boolean
  state: State
  detail?: string
  latencyMs?: number
  count?: number
  withheld?: number
  at?: string
}

export interface Result {
  sections: MemoryRecall.Section[]
  notices: string[]
  /** Tokens set aside for sources inside the overall budget: the sum of their max_tokens. */
  reserve: number
  /** Labels of the sources that answered, for the trace. */
  labels: string[]
}

export interface Interface {
  /** Query every enabled source for a turn. Never fails and never waits past a source's timeout. */
  readonly recall: (input: { sessionID: string; query: string }) => Effect.Effect<Result>
  /** Every configured source and how it last went, for `/memory sources`. */
  readonly list: (sessionID?: string) => Effect.Effect<Status[]>
  /** Turn a source off or on for one session. False when there is no such source. */
  readonly setSessionOff: (sessionID: string, name: string, off: boolean) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemorySources") {}

type Connection = { kind: "graph"; client: MemorySourceGraph.Client } | { kind: "mcp"; client: MemorySourceMcp.Client }

interface InstanceData {
  directory: string
  clients: Map<string, Promise<Connection>>
  sessionOff: Map<string, Set<string>>
  last: Map<string, Omit<Status, "name" | "type" | "host" | "jurisdiction" | "trusted">>
  /** Denials already written to the audit log, so a denied source isn't logged on every turn. */
  denied: Set<string>
  /** Managed config, read once per instance and only if some source claims to be trusted. */
  managed?: Promise<unknown[]>
}

class Timeout extends Error {}

function race<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(`timed out after ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = yield* InstanceState.make<InstanceData>(
      Effect.fn("MemorySources.state")(function* (ctx) {
        const data: InstanceData = {
          directory: ctx.directory,
          clients: new Map(),
          sessionOff: new Map(),
          last: new Map(),
          denied: new Set(),
        }
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            const open = [...data.clients.values()]
            data.clients.clear()
            await Promise.all(open.map((item) => item.then((c) => c.client.close()).catch(() => {})))
          }),
        )
        return data
      }),
    )

    const settings = Effect.fn("MemorySources.settings")(function* () {
      const cfg = yield* config.get()
      const data = yield* InstanceState.get(state)
      const sources = cfg.memory?.sources ?? []
      const managed = sources.some((source) => source.trusted === true)
        ? yield* Effect.promise(() => (data.managed ??= ConfigManaged.readManagedDocs().catch(() => [] as unknown[])))
        : []
      const seen = new Set<string>()
      const list = sources.map((source) => {
        const duplicate = seen.has(source.name)
        seen.add(source.name)
        return {
          source,
          trusted: managedTrust(source, managed),
          problem: duplicate
            ? `another source is already named "${source.name}"`
            : problem(source, cfg.mcp as Record<string, McpEntry> | undefined),
          host: where(source, cfg.mcp as Record<string, McpEntry> | undefined),
        }
      })
      return {
        list,
        mcp: cfg.mcp as Record<string, McpEntry> | undefined,
        residency: AuditLog.residency(cfg),
        maxFactChars: cfg.memory?.limits?.max_fact_chars ?? MemoryBackend.DEFAULT_LIMITS.maxFactChars,
      }
    })

    /** The residency decision for a source, before anything contacts it. Audits a denial once. */
    const gate = (
      data: InstanceData,
      source: ConfigMemorySource.Info,
      host: string,
      residency: Residency.Resolved | undefined,
    ): string | undefined => {
      const jurisdiction = source.jurisdiction?.trim()
      const deny = (reason: string, claimed?: string) => {
        const key = `${source.name}\n${jurisdiction ?? ""}\n${residency?.policy.allow.join(",") ?? ""}`
        if (!data.denied.has(key)) {
          data.denied.add(key)
          AuditLog.emit("memory.source_denied", {
            name: source.name,
            type: source.type,
            host,
            jurisdiction,
            region: claimed,
            reason,
          })
        }
        return reason
      }
      if (!jurisdiction) return deny("it declares no jurisdiction, so the residency policy can't be checked")
      if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(jurisdiction))
        return deny(`jurisdiction "${jurisdiction}" should look like "EU-DE", "EU" or "US"`)
      const claimed = region(jurisdiction)
      if (residency && residency.enforce !== false && !residency.policy.allow.includes(claimed))
        return deny(
          `jurisdiction "${jurisdiction}" (${claimed}) is not allowed by the residency policy (${residency.policy.allow.join(", ")})`,
          claimed,
        )
    }

    const open = (
      data: InstanceData,
      source: ConfigMemorySource.Info,
      mcp: Record<string, McpEntry> | undefined,
    ): Promise<Connection> => {
      const existing = data.clients.get(source.name)
      if (existing) return existing
      const opening: Promise<Connection> =
        source.type === "graph"
          ? MemorySourceGraph.connect(source as ConfigMemorySource.Info & { url: string }).then((client) => ({
              kind: "graph" as const,
              client,
            }))
          : MemorySourceMcp.connect({
              source: source as ConfigMemorySource.Info & { server: string; tool: string },
              server: mcp![source.server!] as ConfigMCPV1.Info,
              directory: data.directory,
            }).then((client) => ({ kind: "mcp" as const, client }))
      data.clients.set(source.name, opening)
      // A connection that fails is forgotten, so the next turn tries again.
      opening.catch(() => {
        if (data.clients.get(source.name) === opening) data.clients.delete(source.name)
      })
      return opening
    }

    /** Drop a source's connection after a failure or timeout, without waiting for it to close. */
    const drop = (data: InstanceData, name: string) => {
      const existing = data.clients.get(name)
      data.clients.delete(name)
      if (existing) void existing.then((c) => c.client.close()).catch(() => {})
    }

    const recall = Effect.fn("MemorySources.recall")(function* (input: { sessionID: string; query: string }) {
      const data = yield* InstanceState.get(state)
      const { list, mcp, residency, maxFactChars } = yield* settings()
      const off = data.sessionOff.get(input.sessionID)
      const result: Result = { sections: [], notices: [], reserve: 0, labels: [] }
      const jobs: Promise<void>[] = []
      for (const { source, trusted, problem: bad, host } of list) {
        if (source.enabled === false || off?.has(source.name)) continue
        if (bad) {
          data.last.set(source.name, { state: "misconfigured", detail: bad })
          continue
        }
        const denied = gate(data, source, host, residency)
        if (denied) {
          data.last.set(source.name, { state: "denied", detail: denied, at: new Date().toISOString() })
          result.notices.push(`Source "${source.name}" was not queried: ${denied}.`)
          continue
        }
        const maxTokens = source.max_tokens ?? DEFAULT_MAX_TOKENS
        const timeout = source.timeout_ms ?? DEFAULT_TIMEOUT_MS
        result.reserve += maxTokens
        const started = Date.now()
        const at = new Date().toISOString()
        jobs.push(
          race(
            open(data, source, mcp).then((connection) =>
              connection.kind === "graph"
                ? connection.client.search(input.query, LIMIT, timeout)
                : connection.client.search(input.query, timeout),
            ),
            timeout,
          ).then(
            (found) => {
              const latency = Date.now() - started
              const kept: string[] = []
              let withheld = 0
              for (const raw of found.slice(0, LIMIT)) {
                const text = raw.replace(/\s+/g, " ").trim()
                if (!text) continue
                if (screen(text, trusted)) {
                  withheld++
                  continue
                }
                kept.push(text.length > maxFactChars ? `${text.slice(0, maxFactChars - 1)}…` : text)
              }
              if (kept.length)
                result.sections.push({ name: source.name, type: source.type, trusted, items: kept, maxTokens })
              if (kept.length) result.labels.push(source.name)
              if (withheld)
                result.notices.push(
                  `${withheld} result${withheld === 1 ? "" : "s"} from source "${source.name}" ${withheld === 1 ? "was" : "were"} withheld: ${withheld === 1 ? "it" : "they"} failed the memory screens (instruction-shaped text, secrets or markup).`,
                )
              data.last.set(source.name, {
                state: kept.length ? "ok" : "empty",
                latencyMs: latency,
                count: kept.length,
                withheld,
                at,
              })
              AuditLog.emit("memory.source_query", {
                session: input.sessionID,
                name: source.name,
                type: source.type,
                host,
                status: "ok",
                latency_ms: latency,
                count: kept.length,
                withheld,
              })
            },
            (error) => {
              const latency = Date.now() - started
              const timedOut = error instanceof Timeout
              drop(data, source.name)
              const detail = timedOut ? `timed out after ${timeout} ms` : message(error)
              data.last.set(source.name, { state: "unavailable", detail, latencyMs: latency, at })
              result.notices.push(
                `Source "${source.name}" is unavailable (${timedOut ? detail : "it failed"}); this answer is without it.`,
              )
              AuditLog.emit("memory.source_query", {
                session: input.sessionID,
                name: source.name,
                type: source.type,
                host,
                status: timedOut ? "timeout" : "error",
                latency_ms: latency,
                count: 0,
              })
            },
          ),
        )
      }
      if (jobs.length) yield* Effect.promise(() => Promise.all(jobs))
      // Keep the configured order, whatever order the sources answered in.
      const order = new Map(list.map((item, index) => [item.source.name, index]))
      result.sections.sort((a, b) => order.get(a.name)! - order.get(b.name)!)
      if (result.notices.length)
        yield* Effect.logWarning("memory sources", { session: input.sessionID, notices: result.notices })
      return result
    })

    const list = Effect.fn("MemorySources.list")(function* (sessionID?: string) {
      const data = yield* InstanceState.get(state)
      const { list: items } = yield* settings()
      const off = sessionID ? data.sessionOff.get(sessionID) : undefined
      return items.map(({ source, trusted, problem: bad, host }): Status => {
        const base = { name: source.name, type: source.type, host, jurisdiction: source.jurisdiction, trusted }
        if (bad) return { ...base, state: "misconfigured", detail: bad }
        if (source.enabled === false) return { ...base, state: "disabled", detail: "enabled is false in config" }
        if (off?.has(source.name)) return { ...base, state: "off", detail: "turned off for this session" }
        return { ...base, ...(data.last.get(source.name) ?? { state: "not queried yet" }) }
      })
    })

    const setSessionOff = Effect.fn("MemorySources.setSessionOff")(function* (
      sessionID: string,
      name: string,
      off: boolean,
    ) {
      const data = yield* InstanceState.get(state)
      const { list: items } = yield* settings()
      if (!items.some((item) => item.source.name === name)) return false
      const set = data.sessionOff.get(sessionID) ?? new Set<string>()
      if (off) set.add(name)
      else set.delete(name)
      data.sessionOff.set(sessionID, set)
      return true
    })

    return Service.of({ recall, list, setSessionOff })
  }),
)

/** The text `/memory sources` shows. */
export function describe(statuses: Status[], memoryOn: boolean) {
  if (!statuses.length)
    return 'No memory sources are configured. Add them under "memory": { "sources": [...] } (see the memory docs).'
  const lines = [
    memoryOn
      ? "Memory sources (read-only, untrusted unless managed config trusts them):"
      : "Memory is off, so no source is queried. Configured sources:",
  ]
  for (const status of statuses) {
    const facts = [
      status.type,
      status.host,
      status.jurisdiction ? `jurisdiction ${status.jurisdiction}` : "no jurisdiction",
      status.trusted ? "trusted (managed config)" : "untrusted",
    ].join(", ")
    const last =
      status.state === "ok" || status.state === "empty"
        ? `${status.state}: ${status.count ?? 0} result(s)${status.withheld ? `, ${status.withheld} withheld` : ""} in ${status.latencyMs} ms`
        : `${status.state}${status.detail ? `: ${status.detail}` : ""}`
    lines.push(`- ${status.name} (${facts}) — ${last}`)
  }
  lines.push(
    "Turn one off for this session with /memory sources off <name>, and back on with /memory sources on <name>.",
  )
  return lines.join("\n")
}

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node] })

export * as MemorySources from "."
