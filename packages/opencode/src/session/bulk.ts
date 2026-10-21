export * as SessionBulk from "./bulk"

import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { AuditLog } from "@/audit/log"
import { CloudSyncApi } from "@/cloud/sync-api"
import { ExternalRegistry } from "@/external/registry"
import { Session } from "./session"
import { SessionLive } from "./live"
import { SessionOverview } from "./overview"
import { SessionPeerControl } from "./peer-control"
import { SessionPeers } from "./peers"
import { SessionPromptQueue } from "./prompt-queue"
import { SessionID } from "./schema"

/**
 * XCOD-265: stopping and clearing many sessions at once, for /sessions, the desktop/web Sessions
 * window, the Agent Monitor and `lunos session stop|archive|unarchive`. Clearing archives: the session
 * is hidden from every list (SessionOverview, the session list, the sidebar) but it, its history and
 * its files stay on disk. Only `removeArchived` deletes, and only sessions already archived.
 *
 * A Lunos session is archived through its `time.archived`; a Claude Code / Codex session that has no
 * Lunos session (an `external:` row) through its registry entry. Subagents follow their parent.
 */

export const EXTERNAL_PREFIX = "external:"
const toolOnly = (id: string) => id.startsWith(EXTERNAL_PREFIX)
const externalID = (id: string) => id.slice(EXTERNAL_PREFIX.length)

type Row = Pick<SessionOverview.Item, "id" | "state" | "elsewhere">

/** Same rule as the per-row stop: a running external tool, or a Lunos session running or waiting. */
export function stoppable(item: Row) {
  if (toolOnly(item.id)) return item.state === "running"
  return item.state === "running" || item.state === "waiting"
}

/** What Clear archives: anything not running or waiting for an answer. */
export function clearable(item: Row) {
  return item.state === "finished" || item.state === "idle" || item.state === "failed"
}

export type Failure = { id: string; reason: string }
export type StopResult = { stopped: string[]; failed: Failure[] }
export type ArchiveResult = { archived: string[]; skipped: Failure[] }
export type DeleteResult = { deleted: string[]; skipped: Failure[]; stopped?: string[] }

/** Sessions running or waiting anywhere on this machine: never archived. */
export async function active(now = Date.now()) {
  const ids = new Set<string>(SessionLive.active())
  for (const [id, peer] of SessionPeers.read({ now })) if (peer.fresh) ids.add(id)
  for (const entry of await ExternalRegistry.list().catch(() => [] as ExternalRegistry.Entry[]))
    if (entry.status === "running") ids.add(`${EXTERNAL_PREFIX}${entry.sessionID}`)
  return ids
}

function reasonOf(error: unknown) {
  if (error instanceof SessionPeerControl.PeerError) {
    if (error.status === 502) return "another Lunos didn't respond"
    if (error.status === 404) return "no running Lunos has it any more"
  }
  return error instanceof Error ? error.message : String(error)
}

async function stopOne(item: Row, reason: string) {
  // XCOD-234: a Claude Code / Codex session ends like `lunos external stop`.
  if (toolOnly(item.id)) {
    const result = await ExternalRegistry.stop(externalID(item.id))
    if (!result.ok) throw new Error(result.reason)
    return
  }
  // Another Lunos runs it: that process rejects its asks and aborts, and audits it.
  if (item.elsewhere) {
    await SessionPeerControl.call(item.id, "/stop", { method: "POST", body: { reason } })
    return
  }
  await SessionPeerControl.stopHere(item.id, reason)
}

/**
 * Stops the listed sessions that can be stopped, all at once. Pending approvals are rejected with
 * `reason` first, so no tool hangs. A row that isn't running (any more) is reported, not an error.
 */
export const stop = Effect.fn("SessionBulk.stop")(function* (input: {
  sessionIDs: readonly string[]
  reason?: string
}) {
  const overview = yield* SessionOverview.build()
  const rows = new Map(overview.sessions.map((item) => [item.id, item]))
  const reason = input.reason ?? SessionPeerControl.STOP_REASON
  const outcomes = yield* Effect.promise(() =>
    Promise.all(
      [...new Set(input.sessionIDs)].map(async (id): Promise<{ id: string; reason?: string }> => {
        const item = rows.get(id)
        if (!item || !stoppable(item)) return { id, reason: "it isn't running" }
        return stopOne(item, reason).then(
          () => ({ id }),
          (error) => ({ id, reason: reasonOf(error) }),
        )
      }),
    ),
  )
  const result: StopResult = {
    stopped: outcomes.filter((item) => !item.reason).map((item) => item.id),
    failed: outcomes.flatMap((item) => (item.reason ? [{ id: item.id, reason: item.reason }] : [])),
  }
  if (outcomes.length)
    AuditLog.emit("session.stop", {
      origin: "bulk",
      count: result.stopped.length,
      ids: result.stopped,
      failed: result.failed.length || undefined,
    })
  return result
})

const descendants = Effect.fn("SessionBulk.descendants")(function* (id: SessionID) {
  const sessions = yield* Session.Service
  const found: SessionID[] = []
  const queue = [id]
  while (queue.length) {
    const next = queue.shift()!
    for (const child of yield* sessions.children(next)) {
      found.push(child.id)
      queue.push(child.id)
    }
  }
  return found
})

/**
 * Archives (`time` set) or restores (`time` undefined) one session and its subagents. Running or
 * waiting subagents are left alone when archiving.
 */
const mark = Effect.fn("SessionBulk.mark")(function* (id: string, time: number | undefined, busy: Set<string>) {
  if (toolOnly(id)) {
    const found = yield* Effect.promise(() =>
      ExternalRegistry.setArchived(externalID(id), time === undefined ? undefined : new Date(time)),
    )
    return found ? undefined : "no such session"
  }
  const sessions = yield* Session.Service
  const sessionID = SessionID.make(id)
  const info = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!info) return "no such session"
  // Already as asked (a subagent its parent's archive reached first): nothing to do.
  if ((time === undefined) === !info.time.archived) return undefined
  const kids = yield* descendants(sessionID)
  for (const target of [sessionID, ...kids]) {
    if (time !== undefined && busy.has(target)) continue
    yield* sessions.setArchived({ sessionID: target, time })
  }
  return undefined
})

/**
 * Hides the listed sessions from every list. A session running or waiting is never archived, unless
 * the same request just stopped it (`stopped`: the other Lunos's heartbeat lags a couple of seconds).
 */
export const archive = Effect.fn("SessionBulk.archive")(function* (input: {
  sessionIDs: readonly string[]
  stopped?: readonly string[]
  now?: number
}) {
  const now = input.now ?? Date.now()
  const busy = yield* Effect.promise(() => active(now))
  for (const id of input.stopped ?? []) busy.delete(id)
  const result: ArchiveResult = { archived: [], skipped: [] }
  for (const id of new Set(input.sessionIDs)) {
    const reason = busy.has(id) ? "it's running or waiting; stop it first" : yield* mark(id, now, busy)
    if (reason) result.skipped.push({ id, reason })
    else result.archived.push(id)
  }
  // Nothing changed, nothing to record.
  if (result.archived.length)
    AuditLog.emit("session.archive", {
      origin: "bulk",
      action: "archive",
      count: result.archived.length,
      ids: result.archived,
    })
  return result
})

/**
 * "Stop all & clear": stops the running and waiting ones among `sessionIDs`, then archives every
 * one that was stopped or wasn't running. A session that couldn't be stopped stays listed.
 */
export const stopAndArchive = Effect.fn("SessionBulk.stopAndArchive")(function* (input: {
  sessionIDs: readonly string[]
  reason?: string
}) {
  const overview = yield* SessionOverview.build()
  const rows = new Map(overview.sessions.map((item) => [item.id, item]))
  const running = input.sessionIDs.filter((id) => {
    const item = rows.get(id)
    return item && stoppable(item)
  })
  const stopped = running.length
    ? yield* stop({ sessionIDs: running, reason: input.reason })
    : { stopped: [], failed: [] }
  const failed = new Set(stopped.failed.map((item) => item.id))
  const archived = yield* archive({
    sessionIDs: input.sessionIDs.filter((id) => !failed.has(id)),
    stopped: stopped.stopped,
  })
  return { ...archived, stopped: stopped.stopped, failed: stopped.failed }
})

/** Every archived session (and external row), for `lunos session unarchive --all`. */
export const archived = Effect.fn("SessionBulk.archived")(function* () {
  return (yield* SessionOverview.build({ archived: true })).sessions
    .filter((item) => !item.parentID)
    .map((item) => item.id)
})

/** Puts archived sessions back in the lists (Undo, Unarchive). */
export const unarchive = Effect.fn("SessionBulk.unarchive")(function* (input: { sessionIDs: readonly string[] }) {
  const result: ArchiveResult = { archived: [], skipped: [] }
  for (const id of new Set(input.sessionIDs)) {
    const reason = yield* mark(id, undefined, new Set())
    if (reason) result.skipped.push({ id, reason })
    else result.archived.push(id)
  }
  if (result.archived.length)
    AuditLog.emit("session.archive", {
      origin: "bulk",
      action: "unarchive",
      count: result.archived.length,
      ids: result.archived,
    })
  return result
})

/** XCOD-284: where a delete came from, for the audit log. */
export type Origin = "single" | "bulk" | "cli"

/** XCOD-284: the synced copy on Lunos Cloud, deleted (`deleted: true`) or not there to delete. */
export type CloudRemove = (session: string) => Promise<CloudSyncApi.RemoveResult>

export type RemoveInput = {
  sessionIDs: readonly string[]
  /**
   * Only sessions already archived (Delete archived). The default: a listed session is reached only
   * when the caller asks for it (`false`), from /sessions' Delete or `lunos session delete`.
   */
  archivedOnly?: boolean
  /** Stop the running and waiting ones first (as Stop all); otherwise they are skipped. */
  stop?: boolean
  /** Leave the synced copy on Lunos Cloud. By default it is deleted too. */
  keepCloud?: boolean
  origin?: Origin
  reason?: string
  /** Removes a session's share link; the server passes SessionShare.unshare. Without one, links stay. */
  unshare?: (sessionID: SessionID) => Effect.Effect<void, unknown>
  /** For tests; CloudSyncApi.removeSession otherwise. */
  cloud?: CloudRemove
}

const cloudReason = (failure: CloudSyncApi.Failure) =>
  failure.code === "signed_out"
    ? "its synced copy couldn't be deleted: you're signed out (sign in, or keep the synced copy)"
    : `its synced copy couldn't be deleted (${failure.message})`

/**
 * Deletes sessions and their history for good: messages, subagent sessions and prompts queued for
 * them (Session.remove). In order, for each: a running one is stopped first (`stop`) or skipped; its
 * share link is removed (`unshare`); its synced copy is deleted unless `keepCloud`; then the session.
 * A step that fails leaves the session as it was and says why, so it can be tried again.
 *
 * For an external row (a Claude Code / Codex session with no Lunos session) only Lunos's registry
 * entry goes; the tool's own transcript is left where it is. Files the agent changed are never touched.
 */
export const remove = Effect.fn("SessionBulk.remove")(function* (input: RemoveInput) {
  const sessions = yield* Session.Service
  const archivedOnly = input.archivedOnly !== false
  const ids = [...new Set(input.sessionIDs)]
  const result: DeleteResult = { deleted: [], skipped: [] }
  const skip = new Map<string, string>()

  // Running or waiting ones: stopped first, or left alone.
  const busy = yield* Effect.promise(() => active())
  const running = ids.filter((id) => busy.has(id))
  if (running.length && input.stop) {
    const stopped = yield* stop({ sessionIDs: running, reason: input.reason })
    result.stopped = stopped.stopped
    // The other Lunos's heartbeat lags a couple of seconds: what this request stopped isn't busy.
    for (const id of stopped.stopped) busy.delete(id)
    for (const failure of stopped.failed) skip.set(failure.id, `couldn't stop it: ${failure.reason}`)
  }
  for (const id of running) if (busy.has(id) && !skip.has(id)) skip.set(id, "it's running or waiting; stop it first")

  const cloud: CloudRemove = input.cloud ?? ((session) => CloudSyncApi.removeSession(session))
  // XCOD-269: prompts queued for them and never sent go with them (Session.remove); counted here.
  let queued = 0
  let cloudDeleted = 0
  for (const id of ids) {
    const skipped = skip.get(id)
    if (skipped) {
      result.skipped.push({ id, reason: skipped })
      continue
    }
    if (toolOnly(id)) {
      const entry = yield* Effect.promise(() => ExternalRegistry.get(externalID(id)))
      if (!entry || (archivedOnly && !entry.archived)) {
        result.skipped.push({ id, reason: entry ? "it isn't archived" : "no such session" })
        continue
      }
      yield* Effect.promise(() => ExternalRegistry.remove(externalID(id)))
      result.deleted.push(id)
      continue
    }
    const sessionID = SessionID.make(id)
    const info = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info || (archivedOnly && !info.time.archived)) {
      result.skipped.push({ id, reason: info ? "it isn't archived" : "no such session" })
      continue
    }
    // The share link first: once the session is gone there is nothing left to unshare it by.
    if (info.share && input.unshare) {
      const reason = yield* input.unshare(sessionID).pipe(
        Effect.as(undefined),
        Effect.catch((error: unknown) =>
          Effect.succeed(
            `its share link couldn't be removed (${error instanceof Error ? error.message : String(error)})`,
          ),
        ),
      )
      if (reason) {
        result.skipped.push({ id, reason })
        continue
      }
    }
    // Its subagents synced as sessions of their own.
    const kids = yield* descendants(sessionID)
    if (!input.keepCloud) {
      let failed: string | undefined
      for (const target of [sessionID, ...kids]) {
        const outcome = yield* Effect.promise(() =>
          cloud(target).catch(
            (error): CloudSyncApi.Failure => ({ ok: false, status: 0, code: "network", message: String(error) }),
          ),
        )
        if (!outcome.ok) {
          failed = cloudReason(outcome)
          break
        }
        if (outcome.deleted) cloudDeleted++
      }
      if (failed) {
        result.skipped.push({ id, reason: failed })
        continue
      }
    }
    const held = SessionPromptQueue.held(id)
    const removed = yield* sessions.remove(sessionID).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (removed) queued += held
    if (removed) result.deleted.push(id)
    else result.skipped.push({ id, reason: "no such session" })
    // A Claude Code / Codex session Lunos ran (XCOD-218) would be listed on its own once its Lunos
    // session is gone: its registry entry, Lunos's own file, goes too. The tool's transcript stays.
    const linked = SessionOverview.externalOf(info)?.session
    if (removed && linked) yield* Effect.promise(() => ExternalRegistry.remove(linked).catch(() => undefined))
  }
  if (result.deleted.length)
    AuditLog.emit("session.delete", {
      origin: input.origin ?? "bulk",
      count: result.deleted.length,
      ids: result.deleted,
      queued_discarded: queued,
      ...(result.stopped?.length ? { stopped: result.stopped.length } : {}),
      ...(cloudDeleted ? { cloud_deleted: cloudDeleted } : {}),
      ...(input.keepCloud ? { cloud_kept: true } : {}),
    })
  return result
})

/**
 * Deletes archived sessions and their history for good (Delete archived). Anything not archived is
 * refused, so this can never reach a session that is still listed.
 */
export const removeArchived = Effect.fn("SessionBulk.removeArchived")(function* (input: {
  sessionIDs: readonly string[]
  keepCloud?: boolean
  unshare?: RemoveInput["unshare"]
  cloud?: CloudRemove
}) {
  // As before XCOD-284, synced copies are left unless the caller asks (keepCloud: false).
  return yield* remove({ ...input, keepCloud: input.keepCloud ?? true, archivedOnly: true, origin: "bulk" })
})

/**
 * XCOD-284: what deleting these sessions removes, for the confirmation: per session its messages,
 * subagent sessions and queued prompts, whether it's shared, and whether it's a tool's session (whose
 * own history stays). `sync`: this device syncs to Lunos Cloud, so a synced copy may exist.
 */
export const preview = Effect.fn("SessionBulk.preview")(function* (input: { sessionIDs: readonly string[] }) {
  const sessions = yield* Session.Service
  const items: PreviewItem[] = []
  for (const id of new Set(input.sessionIDs)) {
    if (toolOnly(id)) {
      const entry = yield* Effect.promise(() => ExternalRegistry.get(externalID(id)))
      if (entry) items.push({ id, messages: 0, children: 0, queued: 0, shared: false, tool: entry.tool })
      continue
    }
    const sessionID = SessionID.make(id)
    const info = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info) continue
    const kids = yield* descendants(sessionID)
    const messages = yield* messageCount(sessionID)
    const tool = SessionOverview.externalOf(info)?.tool
    items.push({
      id,
      messages,
      children: kids.length,
      queued: SessionPromptQueue.held(id),
      shared: !!info.share,
      ...(tool ? { tool } : {}),
    })
  }
  const state = yield* Effect.promise(() => CloudSyncApi.load())
  return { items, sync: !!state?.device.syncEnabled }
})

const messageCount = Effect.fn("SessionBulk.messageCount")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ count: sql<number>`count(*)` })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return Number(row?.count ?? 0)
})

export type PreviewItem = {
  id: string
  messages: number
  children: number
  queued: number
  shared: boolean
  /** A Claude Code / Codex session: that tool keeps its own history. */
  tool?: string
}

/**
 * Sessions Clear would archive, however old, for `lunos session archive --finished`: top-level
 * sessions and external rows that are not running or waiting and not already archived, last
 * active before `before` when given.
 */
export const finished = Effect.fn("SessionBulk.finished")(function* (input?: { before?: number; limit?: number }) {
  const sessions = yield* Session.Service
  const busy = yield* Effect.promise(() => active())
  const rows = yield* sessions.listGlobal({ roots: true, limit: input?.limit ?? 10_000 })
  const before = input?.before
  const ids = rows
    .filter((row) => !busy.has(row.id) && (before === undefined || row.time.updated < before))
    .map((row) => row.id as string)
  // XCOD-218: a tool session that has a Lunos session is listed (and archived) as that session.
  const linked = new Set(rows.flatMap((row) => SessionOverview.externalOf(row)?.session ?? []))
  for (const entry of yield* Effect.promise(() =>
    ExternalRegistry.list().catch(() => [] as ExternalRegistry.Entry[]),
  )) {
    const id = `${EXTERNAL_PREFIX}${entry.sessionID}`
    if (entry.archived || busy.has(id) || linked.has(entry.sessionID)) continue
    if (before !== undefined && (Date.parse(entry.updated) || 0) >= before) continue
    ids.push(id)
  }
  return ids
})
