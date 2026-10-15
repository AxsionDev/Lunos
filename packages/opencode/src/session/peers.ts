export * as SessionPeers from "./peers"

import { randomBytes } from "crypto"
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "fs"
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
 */

export const HEARTBEAT_MS = 2_000
export const STALE_MS = 3 * HEARTBEAT_MS
/** Files of processes gone for this long are deleted by whoever reads them. */
const FORGET_MS = 60 * 60 * 1000

/** A session's state, and the project directory its process serves it under. */
export type Claim = SessionLive.Activity & { directory?: string }
/** Where that process takes stop and approval answers (loopback only; see SessionPeerControl). */
export type Control = { port: number; token: string }
export type File = { version: 1; pid: number; heartbeat: number; sessions: Record<string, Claim>; control?: Control }
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

/** XCOD-234: this process's control endpoint, written into its file for the other processes. */
export function setControl(value: Control | undefined) {
  control = value
}
let beat: ReturnType<typeof setInterval> | undefined
let exitHooked = false

function write() {
  ensureDir()
  const body: File = {
    version: 1,
    pid: process.pid,
    heartbeat: Date.now(),
    sessions: current,
    ...(control ? { control } : {}),
  }
  const tmp = `${own()}.${randomBytes(3).toString("hex")}.tmp`
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
  renameSync(tmp, own())
}

function remove() {
  rmSync(own(), { force: true })
}

/**
 * Publishes this process's active sessions (status or pending approvals). With none, the file is
 * removed and the heartbeat stops, so an idle Lunos writes nothing.
 */
export function publish(sessions: Record<string, Claim>) {
  current = sessions
  try {
    if (Object.keys(sessions).length === 0) {
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
    if (!exitHooked) {
      exitHooked = true
      process.once("exit", () => {
        try {
          remove()
        } catch {}
      })
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
    let body: File
    try {
      // Only the user's own files: on a shared machine another account can't plant claims here.
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        statSync(file).uid !== process.getuid()
      )
        continue
      body = JSON.parse(readFileSync(file, "utf8")) as File
    } catch {
      continue
    }
    if (body?.version !== 1 || typeof body.heartbeat !== "number" || !body.sessions) continue
    const age = now - body.heartbeat
    if (age > FORGET_MS) {
      rmSync(file, { force: true })
      continue
    }
    const fresh = age <= STALE_MS
    for (const [sessionID, claim] of Object.entries(body.sessions)) {
      if (!claim || typeof claim !== "object") continue
      const known = result.get(sessionID)
      if (known?.fresh && !fresh) continue
      const ctl = body.control
      result.set(sessionID, {
        status: claim.status === "busy" || claim.status === "retry" ? claim.status : undefined,
        permissions: Number.isInteger(claim.permissions) && claim.permissions > 0 ? claim.permissions : 0,
        questions: Number.isInteger(claim.questions) && claim.questions > 0 ? claim.questions : 0,
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

/** What readers would show, as one comparable string. */
function snapshot() {
  return [...read()]
    .map(([id, peer]) => `${id}:${peer.fresh}:${peer.status ?? ""}:${peer.permissions}:${peer.questions}`)
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
  remove()
}
