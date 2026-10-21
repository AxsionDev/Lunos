export * as CloudShareRecord from "./share-record"

import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { CloudAuth } from "./auth"
import { CloudOrg } from "./org"
import { CloudShare } from "./share"

/**
 * Which console shares (`lunos share <session>`, the TUI's `/share` to the console) were made from
 * which session, so deleting the session revokes them too. A console share is a separate upload:
 * the console doesn't know the session it came from, so this machine remembers it. One JSON file
 * under the data directory: share ids, their URL and the console they went to, never content or
 * titles. Shares made before this existed aren't in it, and are revoked by hand
 * (`lunos share list`, then `lunos share revoke <id>`).
 *
 * Entries are keyed by session id and never pruned for sessions this process doesn't know: one data
 * directory can serve several Lunos databases (one per release channel).
 */

export interface Entry {
  /** The share's id on the console (`lunos share revoke <id>`). */
  id: string
  url?: string
  org: string
  /** `<console>/v1/orgs/<org>`: the console it was shared to. */
  base: string
  created: number
}

interface State {
  version: 1
  sessions: Record<string, Entry[]>
}

export const file = () => path.join(Global.Path.data, "console-shares.json")

const empty = (): State => ({ version: 1, sessions: {} })

const valid = (entry: unknown): entry is Entry =>
  !!entry &&
  typeof entry === "object" &&
  typeof (entry as Entry).id === "string" &&
  typeof (entry as Entry).base === "string" &&
  typeof (entry as Entry).org === "string"

async function read(): Promise<State> {
  const text = await fsp.readFile(file(), "utf8").catch(() => undefined)
  if (text === undefined) return empty()
  try {
    const value = JSON.parse(text)
    const state = empty()
    if (value?.sessions && typeof value.sessions === "object")
      for (const [session, list] of Object.entries(value.sessions))
        if (Array.isArray(list)) {
          const entries = list.filter(valid)
          if (entries.length) state.sessions[session] = entries
        }
    return state
  } catch {
    return empty()
  }
}

/** Read-modify-write under a lock: the TUI, the desktop sidecar, `lunos serve` and the CLI all write it. */
async function update<T>(change: (state: State) => T): Promise<T> {
  return Flock.withLock(`console-shares:${file()}`, async () => {
    const state = await read()
    const result = change(state)
    await fsp.mkdir(path.dirname(file()), { recursive: true })
    const next = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
    await fsp.writeFile(next, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
    await fsp.rename(next, file())
    return result
  })
}

/** Remembers that `shared` was made from `sessionID`, on `org`'s console. */
export async function record(sessionID: string, org: CloudOrg.Org, shared: { id: string; url?: string }) {
  await update((state) => {
    const list = (state.sessions[sessionID] ?? []).filter((entry) => entry.id !== shared.id)
    list.push({
      id: shared.id,
      ...(shared.url ? { url: shared.url } : {}),
      org: org.org,
      base: org.base,
      created: Date.now(),
    })
    state.sessions[sessionID] = list
  })
}

/** The console shares recorded for these sessions, by session. */
export async function forSessions(sessionIDs: readonly string[]) {
  const state = await read()
  return new Map(sessionIDs.flatMap((id) => (state.sessions[id]?.length ? [[id, state.sessions[id]!] as const] : [])))
}

/** Forgets shares (all of a session's when `ids` is left out). */
export async function forget(sessionID: string, ids?: readonly string[]) {
  if (!(await read()).sessions[sessionID]) return
  await update((state) => {
    const kept = ids ? (state.sessions[sessionID] ?? []).filter((entry) => !ids.includes(entry.id)) : []
    if (kept.length) state.sessions[sessionID] = kept
    else delete state.sessions[sessionID]
  })
}

/** Forgets one share wherever it is recorded: `lunos share revoke <id>` revoked it already. */
export async function forgetShare(id: string) {
  const state = await read()
  if (!Object.values(state.sessions).some((list) => list.some((entry) => entry.id === id))) return
  await update((state) => {
    for (const [session, list] of Object.entries(state.sessions)) {
      const kept = list.filter((entry) => entry.id !== id)
      if (kept.length) state.sessions[session] = kept
      else delete state.sessions[session]
    }
  })
}

export type RevokeOutcome = {
  /** The share ids revoked (or already gone on the console). */
  revoked: string[]
  /** Why some couldn't be revoked: those are still recorded, and still live. */
  error?: string
}

const host = (base: string) => {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

/**
 * Revokes every console share recorded for these sessions (`DELETE shares/{id}`) and forgets the
 * ones revoked. A share the console no longer has (404) counts as revoked. The token only ever goes
 * to the console this machine's managed config names: a share recorded for another console is
 * reported, not sent there. Nothing recorded: nothing is asked of anyone.
 */
export async function revoke(sessionIDs: readonly string[], opts: CloudOrg.Options = {}): Promise<RevokeOutcome> {
  const recorded = await forSessions(sessionIDs)
  if (!recorded.size) return { revoked: [] }
  const org = await CloudOrg.resolve()
  const revoked: string[] = []
  const failed: string[] = []
  const why = new Set<string>()
  for (const [session, entries] of recorded) {
    const done: string[] = []
    for (const entry of entries) {
      if (!org || org.base !== entry.base) {
        failed.push(entry.id)
        why.add(
          org
            ? `${entry.id} is on ${host(entry.base)}, not your organisation's console here (${org.host})`
            : `${entry.id} is on ${host(entry.base)}, and no organisation console is configured here`,
        )
        continue
      }
      const error = await CloudShare.revoke(org, entry.id, opts).then(
        () => undefined,
        (error: unknown) => error,
      )
      if (!error || (error instanceof CloudOrg.ConsoleError && error.status === 404)) {
        done.push(entry.id)
        continue
      }
      failed.push(entry.id)
      why.add(
        error instanceof CloudAuth.SignedOutError
          ? "you're signed out"
          : error instanceof Error
            ? error.message
            : String(error),
      )
    }
    if (done.length) await forget(session, done)
    revoked.push(...done)
  }
  if (!failed.length) return { revoked }
  return {
    revoked,
    error: `its console ${failed.length === 1 ? "share" : "shares"} ${failed.join(", ")} couldn't be revoked (${[...why].join("; ")})`,
  }
}
