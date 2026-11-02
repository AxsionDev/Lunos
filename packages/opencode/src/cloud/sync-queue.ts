export * as CloudSyncQueue from "./sync-queue"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

/**
 * Session sync's on-disk queue (lunos-web spec 2026-10-13 §3). It holds redacted chunk bodies only,
 * never raw content (the path rule and credential scanner ran before `enqueue`), one file per chunk,
 * each deleted as soon as the control plane acknowledges it. `cursor.json` records how far a session
 * has been chunked, so an upload that fails or a process that exits resumes without re-sending.
 */
export type Cursor = { session: string; directory: string; seq: number; sent: string[]; stopped?: "deleted" | "denied" }

export const dir = () => path.join(Global.Path.data, "cloud", "sync", "queue")

function sessionDir(session: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error(`Invalid session id for the sync queue: ${session}`)
  return path.join(dir(), session)
}

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  let renamed = false
  try {
    await fs.writeFile(tmp, text, { mode: 0o600 })
    await fs.rename(tmp, file)
    renamed = true
  } finally {
    if (!renamed) await fs.rm(tmp, { force: true })
  }
}

/** A chunk file for this seq already exists with different content. */
export class SeqTakenError extends Error {
  constructor(
    readonly session: string,
    readonly seq: number,
  ) {
    super(`Sync queue: chunk ${seq} of ${session} already exists with different content`)
  }
}

const LOCK_RETRY_MS = 50
const LOCK_WAIT_MS = 5_000
const LOCK_STALE_MS = 30_000

/** Per-session lock across processes (a TUI and `lunos run` can share a session): `.lock`, created exclusively. */
async function locked<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const d = sessionDir(session)
  const lock = path.join(d, ".lock")
  await fs.mkdir(d, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const stat = await fs.stat(lock).catch(() => undefined)
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`Sync queue: timed out waiting for the lock on ${session}`)
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lock, { force: true })
  }
}

export async function cursor(session: string): Promise<Cursor | undefined> {
  return fs
    .readFile(path.join(sessionDir(session), "cursor.json"), "utf8")
    .then((t) => {
      const c = JSON.parse(t) as Partial<Cursor> | null
      const ok =
        !!c &&
        typeof c.session === "string" &&
        typeof c.directory === "string" &&
        Number.isInteger(c.seq) &&
        c.seq! >= 0 &&
        Array.isArray(c.sent) &&
        c.sent.every((m) => typeof m === "string") &&
        (c.stopped === undefined || c.stopped === "deleted" || c.stopped === "denied")
      return ok ? (c as Cursor) : undefined
    })
    .catch(() => undefined)
}

export async function writeCursor(c: Cursor) {
  await write(path.join(sessionDir(c.session), "cursor.json"), JSON.stringify(c))
}

/** Returns false, writing nothing, when the session is stopped; throws SeqTakenError if `seq` holds other content. */
export async function enqueue(session: string, directory: string, seq: number, body: string, messageIDs: string[]) {
  return locked(session, async () => {
    const current = await cursor(session)
    if (current?.stopped) return false
    const file = path.join(sessionDir(session), `${seq}.json`)
    const existing = await fs.readFile(file, "utf8").catch(() => undefined)
    if (existing !== undefined && existing !== body) throw new SeqTakenError(session, seq)
    if (existing === undefined) await write(file, body)
    await writeCursor({
      ...current,
      session,
      directory,
      seq: Math.max(current?.seq ?? 0, seq),
      sent: [...new Set([...(current?.sent ?? []), ...messageIDs])],
    })
    return true
  })
}

async function files(session: string) {
  const names = await fs.readdir(sessionDir(session)).catch(() => [] as string[])
  return names.flatMap((n) => (/^\d+\.json$/.test(n) ? [Number.parseInt(n, 10)] : [])).sort((a, b) => a - b)
}

export async function pending(session?: string) {
  const sessions = session
    ? [session]
    : (await fs.readdir(dir()).catch(() => [] as string[])).filter((n) => /^[A-Za-z0-9_-]+$/.test(n)).sort()
  const out: Array<{ session: string; seq: number; body: string }> = []
  for (const s of sessions)
    for (const seq of await files(s)) {
      const body = await fs.readFile(path.join(sessionDir(s), `${seq}.json`), "utf8").catch(() => undefined)
      if (body !== undefined) out.push({ session: s, seq, body })
    }
  return out
}

/** Deletes chunk `seq` and every lower one. */
export async function ack(session: string, seq: number) {
  await locked(session, async () => {
    for (const n of await files(session))
      if (n <= seq) await fs.rm(path.join(sessionDir(session), `${n}.json`), { force: true })
  })
}

/**
 * Starts the session over from the server's position: deletes every queued chunk and sets the cursor
 * to `seq` with nothing sent, so the next build re-chunks every message after it. One lock, so no
 * enqueue from another process lands in between.
 */
export async function reset(session: string, seq: number) {
  await locked(session, async () => {
    for (const n of await files(session)) await fs.rm(path.join(sessionDir(session), `${n}.json`), { force: true })
    const current = await cursor(session)
    await writeCursor({ session, directory: "", ...current, seq, sent: [] })
  })
}

export async function drop(session: string, reason: "deleted" | "denied") {
  await locked(session, async () => {
    for (const n of await files(session)) await fs.rm(path.join(sessionDir(session), `${n}.json`), { force: true })
    const current = await cursor(session)
    await writeCursor({ session, directory: "", seq: 0, sent: [], ...current, stopped: reason })
  })
}

/** Milliseconds to wait after `attempt` consecutive failures: 1 s doubling to 10 min, plus up to 20% jitter. */
export function backoff(attempt: number) {
  const base = Math.min(600_000, 1000 * 2 ** attempt)
  return Math.round(base * (1 + Math.random() * 0.2))
}
