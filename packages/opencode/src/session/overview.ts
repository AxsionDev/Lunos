export * as SessionOverview from "./overview"

import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { ExternalRegistry } from "@/external/registry"
import { Session } from "./session"
import { SessionGroups } from "./groups"
import { SessionLive } from "./live"
import type { SessionID } from "./schema"

/**
 * XCOD-205: every session on this machine that is running, waiting for an answer or finished
 * recently, across all projects, with its group. Feeds the Sessions window (desktop, web) and,
 * later, the TUI's /sessions view.
 */

export type State = "running" | "waiting" | "idle" | "finished" | "failed"
export type Kind = "session" | "subagent" | "scheduled" | "external"

export interface Item {
  id: string
  kind: Kind
  title: string
  directory: string
  project?: Session.ProjectInfo
  parentID?: string
  agent?: string
  model?: string
  /** External sessions: the tool that runs them (claude, codex). */
  tool?: string
  cost: number
  created: number
  updated: number
  state: State
  /** Running according to the database, but not in this process (another Lunos is running it). */
  elsewhere?: boolean
  permissions: number
  questions: number
  groupID?: string
}

export interface Overview {
  groups: SessionGroups.Group[]
  sessions: Item[]
}

/** "Recently finished": sessions touched in the last week. Running and waiting ones are always listed. */
export const WINDOW = 7 * 24 * 60 * 60 * 1000
export const LIMIT = 300
/** An unfinished turn this old, with nobody in this process running it, is treated as abandoned. */
const STALE = 10 * 60 * 1000

type Last = {
  role?: string
  error?: { name?: string }
  time?: { completed?: number }
  agent?: string
  modelID?: string
  providerID?: string
}

export function state(input: { activity: SessionLive.Activity; last?: Last; updated: number; now: number }): {
  state: State
  elsewhere?: boolean
} {
  if (input.activity.permissions > 0 || input.activity.questions > 0) return { state: "waiting" }
  if (input.activity.status) return { state: "running" }
  const last = input.last
  if (!last || last.role !== "assistant") return { state: "idle" }
  if (last.error) return { state: last.error.name === "MessageAbortedError" ? "idle" : "failed" }
  if (last.time?.completed) return { state: "finished" }
  if (input.now - input.updated < STALE) return { state: "running", elsewhere: true }
  return { state: "idle" }
}

export function kind(session: Pick<Session.Info, "parentID" | "metadata">): Kind {
  if (session.parentID) return "subagent"
  if (session.metadata?.unattended === true) return "scheduled"
  return "session"
}

const lastMessages = Effect.fn("SessionOverview.lastMessages")(function* (ids: string[]) {
  const result = new Map<string, Last>()
  if (ids.length === 0) return result
  const { db } = yield* Database.Service
  // Message ids ascend, so the greatest id is a session's latest message.
  const latest = db
    .select({ id: sql<string>`max(${MessageTable.id})`.as("id") })
    .from(MessageTable)
    .where(inArray(MessageTable.session_id, ids as SessionID[]))
    .groupBy(MessageTable.session_id)
  const rows = yield* db
    .select({ session: MessageTable.session_id, data: MessageTable.data })
    .from(MessageTable)
    .where(inArray(MessageTable.id, latest))
    .all()
    .pipe(Effect.orDie)
  for (const row of rows) result.set(row.session, row.data as Last)
  return result
})

export const build = Effect.fn("SessionOverview.build")(function* (input?: { now?: number }) {
  const now = input?.now ?? Date.now()
  const sessions = yield* Session.Service
  const groups = yield* Effect.promise(() => SessionGroups.read())

  const recent = yield* sessions.listGlobal({ start: now - WINDOW, limit: LIMIT })
  const seen = new Set(recent.map((item) => item.id))
  const older = yield* Effect.forEach(
    [...SessionLive.active()].filter((id) => !seen.has(id as SessionID)),
    (id) =>
      sessions.get(id as SessionID).pipe(
        Effect.map((info) => ({ ...info, project: null }) as Session.GlobalInfo),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
  )
  const all = [...recent, ...older.filter((item): item is Session.GlobalInfo => !!item)]
  const last = yield* lastMessages(all.map((item) => item.id))

  const items: Item[] = all.map((session) => {
    const message = last.get(session.id)
    const activity = SessionLive.get(session.id)
    const derived = state({ activity, last: message, updated: session.time.updated, now })
    const model = session.model
      ? `${session.model.providerID}/${session.model.id}`
      : message?.providerID && message.modelID
        ? `${message.providerID}/${message.modelID}`
        : undefined
    const agent = session.agent ?? message?.agent
    const group = groups.assignments[session.id]
    return {
      id: session.id,
      kind: kind(session),
      title: session.title,
      directory: session.directory,
      ...(session.project ? { project: session.project } : {}),
      ...(session.parentID ? { parentID: session.parentID } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      cost: session.cost ?? 0,
      created: session.time.created,
      updated: session.time.updated,
      state: derived.state,
      ...(derived.elsewhere ? { elsewhere: true } : {}),
      permissions: activity.permissions,
      questions: activity.questions,
      ...(group ? { groupID: group } : {}),
    }
  })

  // XCOD-204: Claude Code / Codex sessions Lunos started. Their transcripts are the tool's own.
  const external = yield* Effect.promise(() => ExternalRegistry.list().catch(() => [] as ExternalRegistry.Entry[]))
  for (const entry of external) {
    const updated = Date.parse(entry.updated) || 0
    if (entry.status !== "running" && now - updated > WINDOW) continue
    const id = `external:${entry.sessionID}`
    const group = groups.assignments[id]
    items.push({
      id,
      kind: "external",
      title: entry.sessionID,
      directory: entry.cwd,
      tool: entry.tool,
      cost: entry.costUSD ?? 0,
      created: Date.parse(entry.started) || updated,
      updated,
      state:
        entry.status === "running"
          ? "running"
          : entry.status === "failed"
            ? "failed"
            : entry.status === "done"
              ? "finished"
              : "idle",
      permissions: 0,
      questions: 0,
      ...(group ? { groupID: group } : {}),
    })
  }

  items.sort((a, b) => b.updated - a.updated)
  return { groups: groups.groups, sessions: items } satisfies Overview
})
