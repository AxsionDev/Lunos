import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { registerDisposer } from "@/effect/instance-registry"

// XCOD-288: long-running commands (dev servers, watchers) the agent starts so it can check its own
// work before handing back. Each one is owned by the session that started it and is stopped:
// - by the agent (the `process` tool),
// - when its session is deleted (Session.remove),
// - when the Lunos instance for its directory is disposed,
// - when this Lunos process exits (a synchronous SIGKILL of the process group),
// - after a fixed lifetime (LIFETIME_MS), and
// - on POSIX shells, by a watchdog inside the process group that notices this Lunos process is gone
//   (SIGKILL, crash) and takes the group down with it, so nothing outlives Lunos by more than ~2 s.
//
// Readiness checks only ever talk to loopback addresses, never through a proxy, and every wait has
// an explicit deadline.

export const LIFETIME_MS = 60 * 60 * 1000
export const READY_TIMEOUT_MS = 60 * 1000
export const READY_TIMEOUT_MAX_MS = 5 * 60 * 1000
/** How long a start without a readiness URL waits, to catch a command that fails immediately. */
export const SETTLE_MS = 1500
const STOP_GRACE_MS = 3000
const ATTEMPT_TIMEOUT_MS = 2000
const WATCH_INTERVAL_S = 2

export type Status = "running" | "exited" | "stopped" | "expired"

export type Info = {
  id: string
  sessionID: string
  directory: string
  command: string
  cwd: string
  pid: number | undefined
  log: string
  startedAt: number
  expiresAt: number
  status: Status
  exitCode?: number | null
  signal?: string | null
  error?: string
  /** Whether a watchdog inside the process group guards against this Lunos process dying. */
  watchdog: boolean
}

type Entry = {
  info: Info
  child: ChildProcess
  timer: ReturnType<typeof setTimeout>
  exited: Promise<void>
}

const entries = new Map<string, Entry>()
let exitHooked = false

// An instance being disposed (its directory closed, the server shutting down) takes its processes.
registerDisposer((directory) => stopDirectory(directory))

function hookExit() {
  if (exitHooked) return
  exitHooked = true
  // Synchronous by necessity: nothing async runs during "exit". SIGKILL, because there is no
  // later moment at which to escalate.
  process.once("exit", () => {
    for (const entry of entries.values()) {
      if (entry.info.status === "running") killGroup(entry.info.pid, "SIGKILL")
    }
  })
}

const POSIX = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"])

/** POSIX shells get the watchdog; others (fish, nu, PowerShell, cmd) rely on the in-process cleanup. */
export function watchable(shell: string) {
  if (process.platform === "win32") return false
  return POSIX.has(path.basename(shell).toLowerCase())
}

/**
 * The command, preceded by a watchdog subshell in the same process group. It ignores HUP/INT/TERM
 * (so stopping the group can't skip its last step), polls every 2 s, and when this Lunos process
 * is gone, the command's shell has exited, or the lifetime is up, it sends TERM then KILL to the
 * whole group, itself included.
 */
export function wrap(command: string, parent: number, lifetimeMs: number) {
  const ticks = Math.max(1, Math.ceil(lifetimeMs / 1000 / WATCH_INTERVAL_S))
  return [
    `__lunos_parent=${parent}; __lunos_left=${ticks}; __lunos_shell=$$`,
    `( trap '' HUP INT TERM; while kill -0 "$__lunos_parent" 2>/dev/null && kill -0 "$__lunos_shell" 2>/dev/null && [ "$__lunos_left" -gt 0 ]; do sleep ${WATCH_INTERVAL_S}; __lunos_left=$((__lunos_left - 1)); done; kill -TERM 0 2>/dev/null; sleep 3; kill -KILL 0 2>/dev/null ) </dev/null >/dev/null 2>&1 &`,
    command,
  ].join("\n")
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {}
}

function groupAlive(pid: number | undefined) {
  if (!pid) return false
  if (process.platform === "win32") return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

export type StartInput = {
  sessionID: string
  directory: string
  command: string
  shell: string
  cwd: string
  env: NodeJS.ProcessEnv
  logDir: string
  lifetimeMs?: number
}

export function start(input: StartInput): Info {
  hookExit()
  const id = "bg_" + randomBytes(4).toString("hex")
  fs.mkdirSync(input.logDir, { recursive: true })
  const log = path.join(input.logDir, `${id}.log`)
  const fd = fs.openSync(log, "a")
  const lifetimeMs = input.lifetimeMs ?? LIFETIME_MS
  const watchdog = watchable(input.shell)
  // A hint most dev servers honour (CRA, many Express templates, Nuxt, Astro...). The bind is
  // checked after readiness either way; see `listening`.
  const env = { ...input.env, HOST: "127.0.0.1" }
  let child: ChildProcess
  try {
    child = watchdog
      ? spawn(input.shell, ["-c", wrap(input.command, process.pid, lifetimeMs)], {
          cwd: input.cwd,
          env,
          stdio: ["ignore", fd, fd],
          detached: true,
        })
      : spawn(input.command, {
          shell: input.shell,
          cwd: input.cwd,
          env,
          stdio: ["ignore", fd, fd],
          detached: process.platform !== "win32",
          windowsHide: true,
        })
  } finally {
    fs.closeSync(fd)
  }
  child.unref()

  const now = Date.now()
  const info: Info = {
    id,
    sessionID: input.sessionID,
    directory: input.directory,
    command: input.command,
    cwd: input.cwd,
    pid: child.pid,
    log,
    startedAt: now,
    expiresAt: now + lifetimeMs,
    status: "running",
    watchdog,
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      if (info.status === "running") info.status = "exited"
      info.exitCode = code
      info.signal = signal
      // The shell is gone; anything it left in its group goes too.
      killGroup(info.pid, "SIGKILL")
      resolve()
    })
    child.once("error", (error) => {
      if (info.status === "running") info.status = "exited"
      info.error = error.message
      resolve()
    })
  })
  const timer = setTimeout(() => void stop(id, "expired"), lifetimeMs)
  timer.unref?.()
  entries.set(id, { info, child, timer, exited })
  return info
}

export function get(id: string) {
  return entries.get(id)?.info
}

export function list(sessionID?: string) {
  return [...entries.values()]
    .map((entry) => entry.info)
    .filter((info) => !sessionID || info.sessionID === sessionID)
    .toSorted((a, b) => a.startedAt - b.startedAt)
}

/** TERM to the whole process group, KILL after a grace period if anything in it is still alive. */
export async function stop(id: string, reason: "stopped" | "expired" = "stopped") {
  const entry = entries.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  if (entry.info.status !== "running") return entry.info
  entry.info.status = reason
  killGroup(entry.info.pid, "SIGTERM")
  const graceful = await Promise.race([
    entry.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS).unref?.()),
  ])
  if (!graceful || groupAlive(entry.info.pid)) killGroup(entry.info.pid, "SIGKILL")
  return entry.info
}

export async function stopSession(sessionID: string) {
  await Promise.all(list(sessionID).map((info) => stop(info.id)))
}

export async function stopDirectory(directory: string) {
  await Promise.all(
    list()
      .filter((info) => info.directory === directory)
      .map((info) => stop(info.id)),
  )
}

/** Stops everything and forgets it. For tests. */
export async function reset() {
  await Promise.all(list().map((info) => stop(info.id)))
  entries.clear()
}

/** The last `maxLines` lines (at most `maxBytes`) of a process's output. */
export function tail(info: Info, maxLines = 40, maxBytes = 8 * 1024) {
  let text = ""
  try {
    const size = fs.statSync(info.log).size
    const fd = fs.openSync(info.log, "r")
    try {
      const length = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      text = buffer.toString("utf-8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ""
  }
  return text.split("\n").slice(-maxLines).join("\n").trimEnd()
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** A readiness URL, accepted only for http(s) on a loopback address. */
export function parseReadyUrl(text: string) {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`Invalid readiness URL: ${text}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`Readiness URL must be http or https: ${text}`)
  const host = url.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(host) && !/^127(\.\d{1,3}){3}$/.test(host))
    throw new Error(
      `Readiness URL must point at this machine (localhost, 127.0.0.1 or [::1]), not ${url.hostname}: ${text}`,
    )
  return url
}

/** One HTTP request, direct (never through HTTP_PROXY), resolving to the status or an error message. */
function probe(url: URL, host: string, signal: AbortSignal) {
  return new Promise<{ status: number } | { error: string }>((resolve) => {
    const client = url.protocol === "https:" ? https : http
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: { host: url.host },
        agent: false,
        timeout: ATTEMPT_TIMEOUT_MS,
        signal,
        // A local dev server's certificate is usually self-signed; this only ever talks to loopback.
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode ?? 0 })
      },
    )
    req.once("timeout", () => req.destroy(new Error(`no answer within ${ATTEMPT_TIMEOUT_MS} ms`)))
    req.once("error", (error) => resolve({ error: error.message }))
    req.end()
  })
}

export type ReadyResult =
  | { ready: true; status: number; elapsedMs: number }
  | { ready: false; reason: "exited" | "timeout" | "aborted"; elapsedMs: number; lastError?: string }

/**
 * Waits until `url` answers with any HTTP response, the process exits, `timeoutMs` passes, or
 * `abort` fires, whichever comes first.
 */
export async function waitReady(info: Info, url: URL, timeoutMs: number, abort?: AbortSignal): Promise<ReadyResult> {
  const started = Date.now()
  const deadline = started + Math.min(timeoutMs, READY_TIMEOUT_MAX_MS)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  // "localhost" may resolve to ::1 first while the server listens on 127.0.0.1 only, or the reverse.
  const hosts = host.toLowerCase() === "localhost" ? ["127.0.0.1", "::1"] : [host]
  let lastError: string | undefined
  const entry = entries.get(info.id)
  while (true) {
    if (abort?.aborted) return { ready: false, reason: "aborted", elapsedMs: Date.now() - started, lastError }
    if (info.status !== "running") return { ready: false, reason: "exited", elapsedMs: Date.now() - started, lastError }
    for (const item of hosts) {
      const signal = abort
        ? AbortSignal.any([abort, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)])
        : AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
      const result = await probe(url, item, signal)
      if ("status" in result) return { ready: true, status: result.status, elapsedMs: Date.now() - started }
      lastError = result.error
    }
    const left = deadline - Date.now()
    if (left <= 0) return { ready: false, reason: "timeout", elapsedMs: Date.now() - started, lastError }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, Math.min(500, left))), entry?.exited])
  }
}

/** Waits up to `ms` for the process to exit, so a command that fails at once is reported as such. */
export async function settle(info: Info, ms = SETTLE_MS) {
  const entry = entries.get(info.id)
  if (!entry) return
  await Promise.race([entry.exited, new Promise((resolve) => setTimeout(resolve, ms))])
}

export type Listening = { checked: true; addresses: string[]; exposed: string[] } | { checked: false; reason: string }

/** Whether `address` (lsof's NAME, e.g. "127.0.0.1:3000", "[::1]:3000", "*:3000") is loopback only. */
export function loopbackAddress(address: string) {
  const host = address.slice(0, address.lastIndexOf(":"))
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * The TCP addresses the process group listens on, from `lsof`; `exposed` are the ones reachable
 * from other machines (a wildcard or a non-loopback interface). Not checked where lsof is missing
 * or on Windows.
 */
export function listening(info: Info): Listening {
  if (process.platform === "win32") return { checked: false, reason: "not checked on Windows" }
  if (!info.pid) return { checked: false, reason: "no process id" }
  const result = spawnSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-g", String(info.pid), "-Fn"], {
    encoding: "utf-8",
    timeout: 5000,
  })
  if (result.error) return { checked: false, reason: "lsof is not available" }
  // lsof exits 1 when nothing matches, with no output; anything else unexpected is "not checked".
  if (result.status !== 0 && result.status !== 1) return { checked: false, reason: `lsof failed (${result.status})` }
  const addresses = [
    ...new Set(
      (result.stdout ?? "")
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1).trim())
        .filter(Boolean),
    ),
  ]
  return { checked: true, addresses, exposed: addresses.filter((item) => !loopbackAddress(item)) }
}

export * as BackgroundShell from "./background"
