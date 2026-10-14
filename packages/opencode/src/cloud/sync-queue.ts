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
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.rename(tmp, file)
}

export async function cursor(session: string): Promise<Cursor | undefined> {
  return fs
    .readFile(path.join(sessionDir(session), "cursor.json"), "utf8")
    .then((t) => JSON.parse(t) as Cursor)
    .catch(() => undefined)
}

export async function writeCursor(c: Cursor) {
  await write(path.join(sessionDir(c.session), "cursor.json"), JSON.stringify(c))
}

export async function enqueue(session: string, directory: string, seq: number, body: string, messageIDs: string[]) {
  await write(path.join(sessionDir(session), `${seq}.json`), body)
  const current = await cursor(session)
  await writeCursor({
    ...current,
    session,
    directory,
    seq: Math.max(current?.seq ?? 0, seq),
    sent: [...new Set([...(current?.sent ?? []), ...messageIDs])],
  })
}

async function files(session: string) {
  const names = await fs.readdir(sessionDir(session)).catch(() => [] as string[])
  return names.flatMap((n) => (/^\d+\.json$/.test(n) ? [Number.parseInt(n, 10)] : [])).sort((a, b) => a - b)
}

export async function pending(session?: string) {
  const sessions = session ? [session] : (await fs.readdir(dir()).catch(() => [] as string[])).filter((n) => /^[A-Za-z0-9_-]+$/.test(n)).sort()
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
  for (const n of await files(session)) if (n <= seq) await fs.rm(path.join(sessionDir(session), `${n}.json`), { force: true })
}

export async function drop(session: string, reason: "deleted" | "denied") {
  for (const n of await files(session)) await fs.rm(path.join(sessionDir(session), `${n}.json`), { force: true })
  const current = await cursor(session)
  await writeCursor({ session, directory: "", seq: 0, sent: [], ...current, stopped: reason })
}

/** Milliseconds to wait after `attempt` consecutive failures: 1 s doubling to 10 min, plus up to 20% jitter. */
export function backoff(attempt: number) {
  const base = Math.min(600_000, 1000 * 2 ** attempt)
  return Math.round(base * (1 + Math.random() * 0.2))
}
