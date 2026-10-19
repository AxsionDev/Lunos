export * as SessionPeers from "./peers"

import { randomBytes } from "crypto"
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
} from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { SessionLive } from "./live"

/**
 * XCOD-234: what the sessions run by *other* Lunos processes on this machine are doing, for the
 * Sessions window. Every process that is running a session or waiting for an answer writes one file,
 * `<data>/live/<pid>-<random>.json`, with a heartbeat and the state of its active sessions, and
 * removes it when it has none. Readers only read files: nothing is sent over the network, and other
 * OS users can't read them (the directory is 0700, each file 0600, under the user's own data dir).
 *
 * A file whose heartbeat is older than STALE_MS belongs to a process that stopped without cleaning
 * up (kill -9, a crash, a closed laptop): its sessions are shown as stale, never as running.
 *
 * XCOD-262: the file also holds the Agent Monitor prompts this process has queued for its sessions
 * (`queue`), written before the queue changes take effect, so they outlive the process. A file that
 * still holds prompts is kept after its process exits (and isn't forgotten after FORGET_MS) until
 * another Lunos takes the session over and sends or discards them. The text is read only by
 * `orphaned` and `removeHeld`, for a take-over: everything else sees counts.
 */

export const HEARTBEAT_MS = 2_000
export const STALE_MS = 3 * HEARTBEAT_MS
/** Files of processes gone for this long are deleted by whoever reads them. */
const FORGET_MS = 60 * 60 * 1000

/** A session's state, and the project directory its process serves it under. */
export type Claim = SessionLive.Activity & { directory?: string }
/** Where that process takes stop and approval answers (loopback only; see SessionPeerControl). */
export type Control = { port: number; token: string }
/** XCOD-262: a prompt queued for a session, kept until its turn ends. */
export type Held = { id: string; text: string }
export type File = {
  version: 1
  pid: number
  heartbeat: number
  sessions: Record<string, Claim>
  control?: Control
  /** XCOD-262: queued Agent Monitor prompts, by session, oldest first. */
  queue?: Record<string, Held[]>
  /** XCOD-262: written as the process exits with prompts still queued; it is gone, whatever the heartbeat says. */
  closed?: true
}
export type Peer = Claim & { fresh: boolean; pid: number; control?: Control }

export const dir = () => path.join(Global.Path.data, "live")

const id = `${process.pid}-${randomBytes(4).toString("hex")}`
export const own = () => path.join(dir(), `${id}.json`)

function ensureDir() {
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  // mkdir leaves an existing directory's mode alone.
  if (process.platform !== "win32") chmodSync(dir(), 0o700)
}

let current: Record<string, Claim> = {}
let control: Control | undefined
let queue: Record<string, Held[]> = {}

/** XCOD-234: this process's control endpoint, written into its file for the other processes. */
export function setControl(value: Control | undefined) {
  control = value
}
let beat: ReturnType<typeof setInterval> | undefined
let exitHooked = false
/** Set by `close`: a late write must not make a process that is going away look alive again. */
let closing = false

/** Replaces `file` in one step (a reader never sees half of it), readable by this OS user only. */
function replace(file: string, body: File) {
  ensureDir()
  const tmp = `${file}.${randomBytes(3).toString("hex")}.tmp`
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
  renameSync(tmp, file)
}

function write(closed = false) {
  replace(own(), {
    version: 1,
    pid: process.pid,
    heartbeat: Date.now(),
    sessions: current,
    ...(control ? { control } : {}),
    ...(Object.keys(queue).length ? { queue } : {}),
    ...(closed ? { closed: true as const } : {}),
  })
  hookExit()
}

function remove() {
  rmSync(own(), { force: true })
}

/**
 * This process is going away: its file goes, unless it holds queued prompts. Then it stays, marked
 * closed, so the others show them as "owner closed" at once rather than after STALE_MS.
 */
export function close() {
  closing = true
  if (beat) clearInterval(beat)
  beat = undefined
  try {
    if (Object.keys(queue).length) write(true)
    else remove()
  } catch {}
}

/** Whether `close` has run: this process's file is final, so nothing it holds may be sent. */
export const closed = () => closing

function hookExit() {
  if (exitHooked) return
  exitHooked = true
  process.once("exit", close)
}

/**
 * XCOD-262: the prompts queued for a session (none: forgotten), written to the file before this
 * returns, so a crash a moment later doesn't lose or repeat one.
 */
export function setQueue(sessionID: string, entries: Held[]) {
  if (entries.length) queue = { ...queue, [sessionID]: entries.map((entry) => ({ id: entry.id, text: entry.text })) }
  else {
    if (!queue[sessionID]) return
    const { [sessionID]: _, ...rest } = queue
    queue = rest
  }
  if (closing) return
  try {
    if (Object.keys(current).length === 0 && Object.keys(queue).length === 0) remove()
    else write()
  } catch {
    // Best effort, as the rest of the file: the prompts are still held in memory.
  }
}

/**
 * Publishes this process's active sessions (status or pending approvals). With none, the file is
 * removed and the heartbeat stops, so an idle Lunos writes nothing.
 */
export function publish(sessions: Record<string, Claim>) {
  current = sessions
  if (closing) return
  try {
    if (Object.keys(sessions).length === 0 && Object.keys(queue).length === 0) {
      if (beat) clearInterval(beat)
      beat = undefined
      remove()
      return
    }
    write()
    if (!beat) {
      beat = setInterval(() => {
        try {
          write()
        } catch {}
      }, HEARTBEAT_MS)
      beat.unref?.()
    }
  } catch {
    // Sharing state is best effort: the window falls back to what the database says.
  }
}

/** Every other process's claims, by session id. A session two processes claim takes the fresh one. */
export function read(input: { now?: number } = {}): Map<string, Peer> {
  const now = input.now ?? Date.now()
  const result = new Map<string, Peer>()
  let names: string[]
  try {
    names = readdirSync(dir())
  } catch {
    return result
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const file = path.join(dir(), name)
    if (file === own()) continue
    const body = load(file)
    if (!body) continue
    const age = now - body.heartbeat
    // Queued prompts stay until a take-over sends or discards them.
    if (age > FORGET_MS && !heldCount(body)) {
      rmSync(file, { force: true })
      continue
    }
    const fresh = isFresh(body, now)
    for (const [sessionID, claim] of Object.entries(body.sessions)) {
      if (!claim || typeof claim !== "object") continue
      const known = result.get(sessionID)
      if (known?.fresh && !fresh) continue
      const ctl = body.control
      result.set(sessionID, {
        status: claim.status === "busy" || claim.status === "retry" ? claim.status : undefined,
        permissions: Number.isInteger(claim.permissions) && claim.permissions > 0 ? claim.permissions : 0,
        questions: Number.isInteger(claim.questions) && claim.questions > 0 ? claim.questions : 0,
        ...(Number.isInteger(claim.queued) && claim.queued! > 0 ? { queued: claim.queued } : {}),
        ...(typeof claim.directory === "string" && claim.directory ? { directory: claim.directory } : {}),
        fresh,
        pid: body.pid,
        ...(ctl &&
        Number.isInteger(ctl.port) &&
        ctl.port > 0 &&
        ctl.port < 65536 &&
        typeof ctl.token === "string" &&
        /^[a-f0-9]{64}$/.test(ctl.token)
          ? { control: { port: ctl.port, token: ctl.token } }
          : {}),
      })
    }
  }
  return result
}

/** Another process's file, or undefined when it isn't one (or isn't this OS user's). */
function load(file: string): File | undefined {
  try {
    // Only the user's own files: on a shared machine another account can't plant claims here.
    if (process.platform !== "win32" && typeof process.getuid === "function" && statSync(file).uid !== process.getuid())
      return undefined
    const body = JSON.parse(readFileSync(file, "utf8")) as File
    if (body?.version !== 1 || typeof body.heartbeat !== "number" || !body.sessions) return undefined
    return body
  } catch {
    return undefined
  }
}

const isFresh = (body: File, now: number) => !body.closed && now - body.heartbeat <= STALE_MS

/** The well-formed queued prompts of one session in a file. */
function heldIn(body: File, sessionID: string): Held[] {
  const list = body.queue?.[sessionID]
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is Held => !!entry && typeof entry.id === "string" && typeof entry.text === "string",
  )
}

function heldCount(body: File) {
  return Object.keys(body.queue ?? {}).reduce((sum, sessionID) => sum + heldIn(body, sessionID).length, 0)
}

/** Every other process's file, by path. */
function others() {
  let names: string[]
  try {
    names = readdirSync(dir())
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir(), name))
    .filter((file) => file !== own())
}

/**
 * XCOD-262: how many prompts processes that stopped (no heartbeat, or closed) still hold for each
 * session: shown as "N queued (owner closed)" until the session is taken over. Counts only.
 */
export function orphans(input: { now?: number } = {}): Map<string, number> {
  const now = input.now ?? Date.now()
  const result = new Map<string, number>()
  for (const file of others()) {
    const body = load(file)
    if (!body || isFresh(body, now)) continue
    for (const sessionID of Object.keys(body.queue ?? {})) {
      const count = heldIn(body, sessionID).length
      if (count) result.set(sessionID, (result.get(sessionID) ?? 0) + count)
    }
  }
  return result
}

/**
 * Whether the process that wrote `body` is gone. It said so as it exited, or its pid no longer
 * exists. A pid that exists while the heartbeat is old is a process that is stopped or suspended,
 * and may yet send its queue itself, unless that is so old the pid must have been reused.
 */
function gone(body: File, now: number) {
  if (body.closed) return true
  if (now - body.heartbeat <= STALE_MS) return false
  if (body.pid === process.pid) return false
  if (!alive(body.pid)) return true
  return now - body.heartbeat > FORGET_MS
}

/**
 * XCOD-262, take-over only: the prompts stopped processes queued for `sessionID`, oldest file
 * first. `gone` is false for a process that still exists: its prompts are not to be taken.
 */
export function orphaned(sessionID: string, input: { now?: number } = {}) {
  const now = input.now ?? Date.now()
  const result: { file: string; gone: boolean; heartbeat: number; entries: Held[] }[] = []
  for (const file of others()) {
    const body = load(file)
    if (!body || isFresh(body, now)) continue
    const entries = heldIn(body, sessionID)
    if (entries.length) result.push({ file, gone: gone(body, now), heartbeat: body.heartbeat, entries })
  }
  return result.toSorted((a, b) => a.heartbeat - b.heartbeat)
}

/**
 * XCOD-262, take-over only: removes one queued prompt from a stopped process's file. The file is
 * rewritten in one step, still 0600, and deleted once it holds no prompts: its process is gone.
 */
export function removeHeld(file: string, sessionID: string, id: string) {
  const body = load(file)
  if (!body) return
  const rest = heldIn(body, sessionID).filter((entry) => entry.id !== id)
  const { [sessionID]: _, ...queue } = body.queue ?? {}
  const next: File = { ...body, queue: rest.length ? { ...queue, [sessionID]: rest } : queue }
  if (!heldCount(next)) return rmSync(file, { force: true })
  replace(file, next)
}

/**
 * XCOD-262: one take-over of a session at a time on this machine. Throws when another live process
 * is taking it over; a lock left by one that crashed is taken. Returns the release.
 */
export function lockTakeover(sessionID: string) {
  ensureDir()
  const file = path.join(dir(), `takeover-${sessionID}.lock`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => rmSync(file, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const pid = Number(readFileSafe(file))
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid))
        throw new Error("Another Lunos is taking this session over.")
      rmSync(file, { force: true })
    }
  }
  throw new Error("Another Lunos is taking this session over.")
}

function readFileSafe(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** Whether a process of this OS user has that pid (EPERM: another user's, so not a Lunos of ours). */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** What readers would show, as one comparable string. */
function snapshot() {
  const held = [...orphans()].map(([id, count]) => `${id}:held:${count}`)
  return [
    ...[...read()].map(
      ([id, peer]) =>
        `${id}:${peer.fresh}:${peer.status ?? ""}:${peer.permissions}:${peer.questions}:${peer.queued ?? 0}`,
    ),
    ...held,
  ]
    .sort()
    .join("|")
}

type Listener = () => void
const listeners = new Set<Listener>()
let watcher: ReturnType<typeof watch> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let sweep: ReturnType<typeof setInterval> | undefined

function notify() {
  timer = undefined
  for (const listener of listeners) listener()
}

/**
 * Calls back when another process's sessions change (a file written or removed), and once per
 * heartbeat timeout so a process that died shows as stale without anything being written.
 */
export function subscribe(listener: Listener) {
  listeners.add(listener)
  if (!watcher) {
    try {
      ensureDir()
      watcher = watch(dir(), (_event, name) => {
        if (name && path.join(dir(), String(name)) === own()) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(notify, 100)
        timer.unref?.()
      })
      watcher.on("error", () => {
        watcher?.close()
        watcher = undefined
      })
      watcher.unref()
    } catch {
      watcher = undefined
    }
    // Also re-read every heartbeat: a process that died changes nothing on disk, and fs.watch can miss
    // events (network home directories) or stop if the directory is removed.
    let last = snapshot()
    sweep = setInterval(() => {
      const next = snapshot()
      if (next !== last) notify()
      last = next
    }, HEARTBEAT_MS)
    sweep.unref?.()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    watcher?.close()
    watcher = undefined
    if (sweep) clearInterval(sweep)
    sweep = undefined
    if (timer) clearTimeout(timer)
    timer = undefined
  }
}

/** For tests. */
export function reset() {
  if (beat) clearInterval(beat)
  beat = undefined
  current = {}
  queue = {}
  closing = false
  remove()
}
