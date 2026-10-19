export * as SessionBulk from "./bulk"

import { Effect } from "effect"
import { AuditLog } from "@/audit/log"
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
export type DeleteResult = { deleted: string[]; skipped: Failure[] }

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

/**
 * Deletes archived sessions and their history for good. Anything not archived is refused, so this
 * can never reach a session that is still listed. For an external row only Lunos's registry entry
 * goes; the tool's own transcript is left where it is.
 */
export const removeArchived = Effect.fn("SessionBulk.removeArchived")(function* (input: {
  sessionIDs: readonly string[]
}) {
  const sessions = yield* Session.Service
  const result: DeleteResult = { deleted: [], skipped: [] }
  // XCOD-269: prompts queued for them and never sent go with them (Session.remove); counted here.
  let queued = 0
  for (const id of new Set(input.sessionIDs)) {
    if (toolOnly(id)) {
      const entry = yield* Effect.promise(() => ExternalRegistry.get(externalID(id)))
      if (!entry?.archived) {
        result.skipped.push({ id, reason: entry ? "it isn't archived" : "no such session" })
        continue
      }
      yield* Effect.promise(() => ExternalRegistry.remove(externalID(id)))
      result.deleted.push(id)
      continue
    }
    const sessionID = SessionID.make(id)
    const info = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info?.time.archived) {
      result.skipped.push({ id, reason: info ? "it isn't archived" : "no such session" })
      continue
    }
    const held = SessionPromptQueue.held(id)
    const removed = yield* sessions.remove(sessionID).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (removed) queued += held
    if (removed) result.deleted.push(id)
    else result.skipped.push({ id, reason: "no such session" })
  }
  if (result.deleted.length)
    AuditLog.emit("session.delete", {
      origin: "bulk",
      count: result.deleted.length,
      ids: result.deleted,
      queued_discarded: queued,
    })
  return result
})

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
