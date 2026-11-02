export * as BudgetSpend from "./spend"

import { and, eq, gte, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectGroup } from "@/project/group"
import { ExternalRegistry } from "@/external/registry"

// XCOD-298: what was spent, from this computer's sessions. Every assistant message's cost counts in
// the project its session belongs to (`ProjectGroup.forSession`): subagents in their parent's,
// Claude Code and Codex turns run in a Lunos session as those sessions' messages, `lunos run` and
// scheduled agents as the sessions they are. Claude Code / Codex sessions started outside a Lunos
// session count from the registry. All amounts are USD, as the model catalogue prices them.
//
// A message with tokens but no cost ran on a model without a price: it's counted as "unknown
// cost", never as 0. (Codex reports tokens but no cost, so its turns are unknown unless priced.)

export interface Turn {
  session: string
  /** The session's title, for reports. */
  title: string
  project: string
  time: number
  /** USD; 0 for an unknown-cost turn. */
  cost: number
  unknown: boolean
  model?: string
  agent?: string
  /** The session is a subagent's. */
  subagent: boolean
}

type Data = {
  role?: string
  cost?: number
  modelID?: string
  providerID?: string
  agent?: string
  tokens?: { total?: number; input?: number; output?: number; reasoning?: number }
}

const tokensOf = (tokens: Data["tokens"]) =>
  (tokens?.total ?? 0) + (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)

/** Every assistant turn since `since`, with the project it counts in. */
export const turns = Effect.fn("BudgetSpend.turns")(function* (since: number, until = Infinity) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({
      session: MessageTable.session_id,
      time: MessageTable.time_created,
      data: MessageTable.data,
    })
    .from(MessageTable)
    .where(and(gte(MessageTable.time_created, since), sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`))
    .all()
    .pipe(Effect.orDie)
  const sessions = yield* db
    .select({
      id: SessionTable.id,
      title: SessionTable.title,
      directory: SessionTable.directory,
      parent: SessionTable.parent_id,
      project: SessionTable.project_id,
      metadata: SessionTable.metadata,
    })
    .from(SessionTable)
    .all()
    .pipe(Effect.orDie)
  const projects = yield* db
    .select({ id: ProjectTable.id, worktree: ProjectTable.worktree, name: ProjectTable.name })
    .from(ProjectTable)
    .all()
    .pipe(Effect.orDie)
  const snapshot = yield* Effect.promise(() => ProjectGroup.snapshot())
  const external = yield* Effect.promise(() => ExternalRegistry.list().catch(() => [] as ExternalRegistry.Entry[]))
  return assign({ rows, sessions, projects, snapshot, external, since, until })
})

/** The pure part of `turns`, for tests. */
export function assign(input: {
  rows: readonly { session: string; time: number; data: unknown }[]
  sessions: readonly {
    id: string
    title: string
    directory: string
    parent: string | null
    project: string
    metadata?: Record<string, unknown> | null
  }[]
  projects: readonly { id: string; worktree: string; name: string | null }[]
  snapshot: ProjectGroup.Snapshot
  external?: readonly ExternalRegistry.Entry[]
  since: number
  until?: number
}): Turn[] {
  const until = input.until ?? Infinity
  const projects = new Map(input.projects.map((item) => [item.id, item]))
  const sessions = new Map(input.sessions.map((item) => [item.id, item]))
  const ref = (id: string): ProjectGroup.SessionRef | undefined => {
    const session = sessions.get(id)
    if (!session) return undefined
    const project = projects.get(session.project)
    return {
      id: session.id,
      directory: session.directory,
      ...(session.parent ? { parentID: session.parent } : {}),
      ...(project ? { project: { id: project.id, worktree: project.worktree, name: project.name ?? undefined } } : {}),
    }
  }
  const cache = new Map<string, string>()
  const projectOf = (id: string) => {
    const known = cache.get(id)
    if (known) return known
    const session = ref(id)
    const group = session ? input.snapshot.forSession(session, ref) : undefined
    const result = group?.id ?? "unknown"
    cache.set(id, result)
    return result
  }
  const result: Turn[] = []
  for (const row of input.rows) {
    if (row.time >= until) continue
    const data = (row.data ?? {}) as Data
    if (data.role !== "assistant") continue
    const cost = Number(data.cost) || 0
    const unknown = cost <= 0 && tokensOf(data.tokens) > 0
    if (cost <= 0 && !unknown) continue
    const session = sessions.get(row.session)
    result.push({
      session: row.session,
      title: session?.title ?? row.session,
      project: projectOf(row.session),
      time: row.time,
      cost: Math.max(0, cost),
      unknown,
      ...(data.modelID ? { model: data.providerID ? `${data.providerID}/${data.modelID}` : data.modelID } : {}),
      ...(data.agent ? { agent: data.agent } : {}),
      subagent: !!session?.parent,
    })
  }
  // Claude Code / Codex sessions Lunos started that aren't also a Lunos session's messages. The
  // registry keeps only the latest turn's cost, so these count that much (a lower bound).
  const linked = new Set(
    input.sessions.flatMap((session) => {
      const external = session.metadata?.external as { session?: unknown } | undefined
      return typeof external?.session === "string" ? [external.session] : []
    }),
  )
  for (const entry of input.external ?? []) {
    const time = Date.parse(entry.updated) || Date.parse(entry.started) || 0
    if (time < input.since || time >= until || linked.has(entry.sessionID)) continue
    const id = `external:${entry.sessionID}`
    const group = input.snapshot.forSession({ id, directory: entry.cwd })
    const cost = entry.costUSD ?? 0
    result.push({
      session: id,
      title: `${entry.tool === "codex" ? "Codex" : "Claude Code"} · ${entry.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ""}`,
      project: group?.id ?? `external:${entry.cwd}`,
      time,
      cost,
      unknown: !(cost > 0),
      model: entry.tool,
      subagent: false,
    })
  }
  return result
}

export interface Total {
  /** USD. */
  spent: number
  /** Turns whose cost isn't known (a model without a price). */
  unknown: number
}

export function total(list: readonly Turn[], filter: (turn: Turn) => boolean = () => true): Total {
  let spent = 0
  let unknown = 0
  for (const turn of list) {
    if (!filter(turn)) continue
    spent += turn.cost
    if (turn.unknown) unknown++
  }
  return { spent, unknown }
}

/** The root session of a session (its own id when it has no parent). */
export const root = Effect.fn("BudgetSpend.root")(function* (sessionID: string) {
  const { db } = yield* Database.Service
  let id = sessionID
  for (let depth = 0; depth < 20; depth++) {
    const row = yield* db
      .select({ parent: SessionTable.parent_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, id as never))
      .get()
      .pipe(Effect.orDie)
    if (!row?.parent) return id
    id = row.parent
  }
  return id
})
