export * as RunLog from "./run-log"

import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { Audit } from "../audit"
import { Global } from "../global"
import { InstallationChannel, versionDetail } from "../installation/version"

/**
 * One log file per run of Lunos, so a failure can say exactly where its details are
 * (`Full log: <path>`) and `lunos logs` / `lunos bug-report` can find it again by its short id.
 *
 * The file lives in the existing log directory (`Global.Path.log`). The CLI starts it once per run
 * (`start`), writing a header; the Effect file logger then writes into it too (see `target`), as do
 * failures (`failure`) and failing external commands (`command`). A TUI's worker thread adopts the
 * same file through `ENV`. Every line written here goes through `redact` first.
 *
 * Node APIs only: the desktop app bundles core for Node.
 */

export const PREFIX = "lunos-"
/** Hands the run log's path to the TUI's worker thread. Read once, then removed from the environment. */
export const ENV = "LUNOS_RUN_LOG"
/** The shared log that processes without a run log of their own (tests, servers, the desktop host) write to. */
export const SHARED = "opencode.log"
/** Output of a failing command kept in the log, from the end. */
export const OUTPUT_LINES = 200

export const DEFAULT_KEEP = 10
export const DEFAULT_RETENTION_DAYS = 14
export const DEFAULT_MAX_MB = 50

export type Result = "ok" | "failed" | "incomplete"
export type Entry = { id: string; file: string; time: Date; size: number; result: Result }

type State = { id: string; file: string; owner: boolean; failed: boolean; headline?: string }
let state: State | undefined
let phases: (() => string | undefined) | undefined
/** The programs this run ran (`docker`, `git`, …), so a failure can add what matters about them. */
const programs = new Set<string>()

export function dir() {
  return Global.Path.log
}

const pad = (value: number) => String(value).padStart(2, "0")

/** `lunos-2026-10-20-1412-a3f9.log`, in local time. */
export function fileName(id: string, date = new Date()) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${PREFIX}${day}-${pad(date.getHours())}${pad(date.getMinutes())}-${id}.log`
}

const NAME = /^lunos-\d{4}-\d{2}-\d{2}-\d{4}-([0-9a-f]+)\.log$/

/** The short id in a run log's file name. */
export function idOf(file: string) {
  return NAME.exec(path.basename(file))?.[1]
}

function names(directory: string) {
  try {
    return readdirSync(directory).filter((name) => NAME.test(name))
  } catch {
    return []
  }
}

function freshId(directory: string) {
  const taken = new Set(names(directory).map((name) => idOf(name)))
  for (let i = 0; i < 100; i++) {
    const id = randomBytes(2).toString("hex")
    if (!taken.has(id)) return id
  }
  return randomBytes(4).toString("hex")
}

// ---------------------------------------------------------------------------------------------
// Redaction

// Not `pwd` or `auth`: PWD, OLDPWD and XAUTHORITY hold paths, and paths belong in the log.
const SECRET_ENV = /(?:api.?key|token|secret|passw(?:or)?d|credential|private.?key)/i
const literals = new Set<string>()

/** Values that must never reach a log, whatever their shape: an API key held in an env var, say. */
export function secret(value: string | undefined) {
  if (value && value.length >= 8) literals.add(value)
}

for (const [name, value] of Object.entries(process.env)) if (SECRET_ENV.test(name)) secret(value)

/** The credential scanner's patterns (the audit trail's), then every known secret value. */
export function redact(text: string) {
  let out = Audit.redact(text)
  for (const value of literals) if (out.includes(value)) out = out.split(value).join("[redacted]")
  return out
}

// ---------------------------------------------------------------------------------------------
// The current run

/** The current run's log, if this process has one. */
export function current(): { id: string; file: string } | undefined {
  if (!state) adopt()
  return state && { id: state.id, file: state.file }
}

/** A worker thread takes its parent's run log from `ENV`. */
export function adopt(env: Record<string, string | undefined> = process.env) {
  const file = env[ENV]
  if (!file || state) return
  delete env[ENV]
  const id = idOf(file)
  if (id) state = { id, file, owner: false, failed: false }
}

/** Where the Effect file logger writes: the run log, or the shared log when there is none. */
export function target() {
  return current()?.file ?? path.join(dir(), SHARED)
}

function write(text: string) {
  if (!state) adopt()
  if (!state) return
  try {
    appendFileSync(state.file, redact(text.endsWith("\n") ? text : text + "\n"))
  } catch {
    // A log that can't be written must never be what stops Lunos.
  }
}

/** Options whose value is kept in the log; any other value could be typed text and is replaced. */
const KEPT_VALUES = new Set([
  "--model",
  "-m",
  "--mode",
  "--agent",
  "--session",
  "-s",
  "--port",
  "--hostname",
  "--log-level",
  "--format",
  "--variant",
])

/**
 * The flags a run was started with, without what was typed as text (a prompt is never logged): the
 * first word is kept when it looks like a command, other positional arguments become `<arg>`, and
 * only the values of the options above are kept.
 */
export function flags(argv: readonly string[]) {
  const out: string[] = []
  let positional = 0
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      if (i + 1 < argv.length) out.push("--", "<arg>")
      break
    }
    if (arg.startsWith("-")) {
      const [name, value] = arg.split(/=(.*)/s, 2) as [string, string | undefined]
      if (value !== undefined) {
        out.push(KEPT_VALUES.has(name) ? arg : `${name}=<arg>`)
        continue
      }
      out.push(name)
      const next = argv[i + 1]
      if (KEPT_VALUES.has(name) && next !== undefined && !next.startsWith("-")) out.push(argv[++i]!)
      continue
    }
    // After an option, a word may be its value (`--prompt hello`): never kept.
    const afterOption = argv[i - 1]?.startsWith("-") ?? false
    out.push(positional++ === 0 && !afterOption && /^[a-z][a-z0-9-]*$/.test(arg) ? arg : "<arg>")
  }
  return out.join(" ")
}

export function header(input: { argv: readonly string[]; lines?: Record<string, string | undefined> }) {
  const shell = process.env.SHELL ?? process.env.ComSpec ?? process.env.COMSPEC
  const terminal = [process.env.TERM_PROGRAM, process.env.TERM_PROGRAM_VERSION].filter(Boolean).join(" ")
  const rows: Record<string, string | undefined> = {
    version: `${versionDetail()} (${InstallationChannel})`,
    executable: process.execPath,
    entry: process.argv[1],
    os: `${os.type()} ${os.release()} (${process.platform}, ${process.arch})`,
    terminal: [terminal || undefined, process.env.TERM, process.env.WT_SESSION ? "Windows Terminal" : undefined]
      .filter(Boolean)
      .join(", "),
    shell,
    node: process.versions.node,
    bun: process.versions.bun,
    cwd: process.cwd(),
    flags: flags(input.argv),
    ...input.lines,
  }
  return [
    `=== Lunos run log, started ${new Date().toISOString()}`,
    ...Object.entries(rows)
      .filter((entry): entry is [string, string] => !!entry[1])
      .map(([key, value]) => `${key}: ${value}`),
    "",
  ].join("\n")
}

/**
 * Start this run's log: a new file in the log directory, with a header. Once per process; a second
 * call returns the first run's log.
 */
export function start(input: { argv: readonly string[]; lines?: Record<string, string | undefined> }) {
  if (state) return { id: state.id, file: state.file }
  const directory = dir()
  const id = freshId(directory)
  const file = path.join(directory, fileName(id))
  state = { id, file, owner: true, failed: false }
  try {
    writeFileSync(file, redact(header(input)), { flag: "a" })
  } catch {}
  return { id, file }
}

/** Add a titled section: the config layers that were loaded, say. */
export function note(title: string, lines: string | readonly string[]) {
  const body = typeof lines === "string" ? lines : lines.join("\n")
  write(`--- ${title}\n${body}`)
}

/**
 * XCOD-276's startup trace, when there is one: a function that returns the phase timings as text.
 * A failure includes them.
 */
export function setPhases(source: (() => string | undefined) | undefined) {
  phases = source
}

const tail = (text: string, lines = OUTPUT_LINES) => {
  const all = text.trimEnd().split("\n")
  return (all.length > lines ? [`… (${all.length - lines} earlier lines)`, ...all.slice(-lines)] : all).join("\n")
}

/** An external command this run ran: always one line; its output too when it failed. */
export function command(input: { cmd: readonly string[]; code: number | null; stdout?: string; stderr?: string }) {
  if (input.cmd[0]) programs.add(path.basename(input.cmd[0]).replace(/\.exe$/i, ""))
  const line = `$ ${input.cmd.join(" ")}  → exit ${input.code ?? "none (killed or timed out)"}`
  if (input.code === 0) return write(line)
  write(
    [
      line,
      ...(input.stdout?.trim() ? ["stdout:", tail(input.stdout)] : []),
      ...(input.stderr?.trim() ? ["stderr:", tail(input.stderr)] : []),
    ].join("\n"),
  )
}

const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

function show(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const COMMAND_FIELDS = ["command", "cmd", "args", "argv", "exitCode", "code", "signal", "stdout", "stderr"]

/**
 * The full error: each level of the cause chain with its stack, the fields of a structured error (a
 * command's exit code and output, say), and what a non-Error throw was.
 */
export function describe(error: unknown) {
  const out: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; current !== undefined && depth < 10 && !seen.has(current); depth++) {
    seen.add(current)
    if (depth > 0) out.push("caused by:")
    if (!(current instanceof Error)) {
      out.push(`non-Error value thrown (${typeOf(current)}): ${show(current)}`)
      break
    }
    out.push(current.stack ?? `${current.name}: ${current.message}`)
    const fields = current as unknown as Record<string, unknown>
    for (const key of Object.keys(fields)) {
      if (key === "cause" || key === "stack" || key === "message") continue
      const value = fields[key]
      if (value === undefined || typeof value === "function") continue
      if (COMMAND_FIELDS.includes(key) && typeof value === "string") {
        out.push(`${key}:`, key === "stdout" || key === "stderr" ? tail(value) : value)
        continue
      }
      out.push(`${key}: ${show(value)}`)
    }
    current = current.cause
  }
  return out.join("\n")
}

/**
 * A failure in this run: written to the log with the full error. `headline` is the one line shown
 * on screen for it, if nothing else showed one.
 */
export function failure(step: string, error: unknown, options: { headline?: string } = {}) {
  current()
  if (!state) return
  state.failed = true
  if (options.headline && !state.headline) state.headline = options.headline
  const trace = phases?.()
  write(
    [
      `=== FAILURE in ${step} at ${new Date().toISOString()}`,
      describe(error),
      ...(trace ? ["startup phases:", trace] : []),
      "",
    ].join("\n"),
  )
}

/** Whether this run ran `program` through `command`. */
export function ran(program: string) {
  return programs.has(program)
}

/** Whether a failure was recorded in this run, and the line to show for it. */
export function failed() {
  return state?.failed ? { headline: state.headline } : undefined
}

/** The last line of a run log, written on the way out. A log without one didn't finish. */
export function finish(code: number | undefined) {
  if (!state?.owner) return
  const result = state.failed || (code !== undefined && code !== 0) ? "failed" : "ok"
  write(`=== result: ${result} (exit ${code ?? 0}) at ${new Date().toISOString()}`)
  state.owner = false
}

// ---------------------------------------------------------------------------------------------
// Finding and pruning logs

function readTail(file: string, bytes = 4096) {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const size = statSync(file).size
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString("utf8")
  } catch {
    return ""
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function resultOf(file: string): Result {
  const match = /=== result: (ok|failed)/.exec(readTail(file).split("\n").slice(-3).join("\n"))
  return (match?.[1] as Result | undefined) ?? "incomplete"
}

/** Run logs, newest first. */
export function list(directory = dir()): Entry[] {
  return names(directory)
    .flatMap((name) => {
      const file = path.join(directory, name)
      try {
        const stat = statSync(file)
        return [{ id: idOf(name)!, file, time: stat.mtime, size: stat.size, result: resultOf(file) }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.time.getTime() - a.time.getTime() || b.file.localeCompare(a.file))
}

/** The newest log whose id starts with `id` (or the newest of all), or undefined. */
export function find(id: string | undefined, directory = dir()) {
  const all = list(directory)
  if (!id) return all[0]
  return all.find((entry) => entry.id === id) ?? all.find((entry) => entry.id.startsWith(id.toLowerCase()))
}

/**
 * Keep the newest `keep` runs, plus every failed or unfinished run from the last `days` days (an
 * unfinished one may be another Lunos that is still running), within `maxMb` in total: the oldest go
 * first. This run's own log is never removed. Returns what was removed.
 */
export function prune(
  options: { keep?: number; days?: number; maxMb?: number } = {},
  directory = dir(),
  now = Date.now(),
) {
  const keep = options.keep ?? DEFAULT_KEEP
  const days = options.days ?? DEFAULT_RETENTION_DAYS
  const max = (options.maxMb ?? DEFAULT_MAX_MB) * 1024 * 1024
  const self = state?.file
  const all = list(directory)
  const kept = all.filter(
    (entry, index) =>
      entry.file === self || index < keep || (entry.result !== "ok" && now - entry.time.getTime() <= days * 86_400_000),
  )
  const removed = all.filter((entry) => !kept.includes(entry))
  let total = kept.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of [...kept].reverse()) {
    if (total <= max) break
    if (entry.file === self) continue
    removed.push(entry)
    total -= entry.size
  }
  const gone: string[] = []
  for (const entry of removed) {
    try {
      unlinkSync(entry.file)
      gone.push(entry.file)
    } catch {
      // Windows won't remove a log another Lunos still has open; it goes next time.
    }
  }
  return gone
}

/** Test seam: forget this process's run log. */
export function reset() {
  state = undefined
  phases = undefined
  programs.clear()
}
