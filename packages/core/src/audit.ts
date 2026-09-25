export * as Audit from "./audit"

// XCOD-103: the organisation audit trail. One JSON-lines stream, extending the residency egress
// log (XCOD-62) rather than adding a second one.
//
// Schema v1 is additive over the v0 residency lines: every v0 field keeps its name and meaning on
// model and share events, and each line gains `v`, `event`, `seq` and `prev`. `prev` is the
// SHA-256 of the previous line's exact bytes (whatever its version), so an edited or removed line
// in the middle of the log breaks the chain. It can NOT detect the last lines being removed, or a
// rewrite that recomputes every later hash: forwarding to a SIEM is what anchors the chain, and
// `seq` lets the SIEM see a gap. The log never holds prompt text, model output or file contents.

import { createHash } from "crypto"
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs"
import { mkdir, readdir, readFile, rename, stat, unlink } from "fs/promises"
import path from "path"

export const VERSION = 1
export const GENESIS = "0".repeat(64)

export const EVENTS = [
  "model.call",
  "model.denied",
  "share.upload",
  "share.denied",
  "tool.run",
  "permission.decision",
  "mcp.connect",
  "marketplace.install",
  "marketplace.refused",
  "policy.override_refused",
  // Defined for XCOD-94; nothing emits them until graph memory exists.
  "memory.write",
  "memory.forget",
  "upgrade",
  "audit.forward_refused",
] as const
export type EventName = (typeof EVENTS)[number]

/** Fields an event may carry. Every field that can hold user data is listed in docs/audit-log.md. */
export type Fields = Record<string, string | number | boolean | undefined | readonly string[]>

export interface Options {
  readonly file: string
  /** Extra patterns whose matches are masked in paths and command lines. */
  readonly redact?: readonly string[]
  /** Rotate when the active file reaches this size. */
  readonly maxBytes?: number
  /** Delete rotated files older than this. */
  readonly maxAgeDays?: number
}

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_MAX_AGE_DAYS = 90

// Masked by default in every string field, whatever `redact` adds: key-shaped strings routinely
// appear in command lines (`curl -H "Authorization: Bearer …"`, `export API_KEY=…`).
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"']+/gi, "$1[redacted]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1[redacted]"],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd|credential)[A-Za-z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi,
    "$1[redacted]",
  ],
  [/(--(?:password|token|secret|api-key)[= ])\S+/gi, "$1[redacted]"],
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})\b/g,
    "[redacted]",
  ],
]

export function redact(value: string, extra: readonly string[] = []): string {
  let out = value
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  for (const source of extra) {
    try {
      out = out.replace(new RegExp(source, "g"), "[redacted]")
    } catch {
      // An invalid user pattern must not stop auditing.
    }
  }
  return out
}

function scrub(fields: Fields, extra: readonly string[]): Fields {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    out[key] =
      typeof value === "string"
        ? redact(value, extra)
        : Array.isArray(value)
          ? value.map((item) => redact(item, extra))
          : value
  }
  return out
}

export function hashLine(line: string) {
  return createHash("sha256").update(line, "utf8").digest("hex")
}

/** The last line of a file, read from its tail, and how many v1 lines it holds so far (`seq`). */
function tail(file: string): { last?: string; seq: number } {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return { seq: 0 }
  }
  const lines = text.split("\n").filter(Boolean)
  const last = lines.at(-1)
  let seq = 0
  if (last) {
    try {
      seq = Number(JSON.parse(last).seq) || 0
    } catch {}
  }
  return { last, seq }
}

// Rotated files are `<file>.<ISO timestamp>`, so a plain sort is chronological.
async function rotated(file: string) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const names = await readdir(dir).catch(() => [] as string[])
  return names
    .filter((name) => name.startsWith(base + ".") && !name.endsWith(".lock"))
    .sort()
    .map((name) => path.join(dir, name))
}

/** Every file of the stream, oldest first: rotated files, then the active one. */
export async function files(file: string) {
  const exists = await stat(file).then(
    () => true,
    () => false,
  )
  return [...(await rotated(file)), ...(exists ? [file] : [])]
}

// Cross-process: the TUI server, `lunos run` and a second TUI may all append at once. The lock
// records its owner and is broken when stale, so a crashed process can't wedge auditing.
const LOCK_STALE_MS = 10_000
function withLock<T>(file: string, fn: () => T): T {
  const lock = file + ".lock"
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(fd, `${process.pid} ${Date.now()}`)
      closeSync(fd)
      break
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock)
      } catch {}
      if (Date.now() > deadline) {
        try {
          unlinkSync(lock)
        } catch {}
      }
      Bun.sleepSync(5)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lock)
    } catch {}
  }
}

// `carry` is the last line of a file just rotated away, so the new file's first line chains to it.
function appendChained(file: string, event: EventName, fields: Fields, now: Date, carry?: string) {
  return withLock(file, () => {
    const current = tail(file)
    const last = current.last ?? carry
    let seq = current.seq
    if (current.last === undefined && carry !== undefined) {
      try {
        seq = Number(JSON.parse(carry).seq) || 0
      } catch {}
    }
    const line = JSON.stringify({
      v: VERSION,
      event,
      timestamp: now.toISOString(),
      ...fields,
      seq: seq + 1,
      prev: last === undefined ? GENESIS : hashLine(last),
    })
    const fd = openSync(file, "a")
    try {
      writeSync(fd, line + "\n")
    } finally {
      closeSync(fd)
    }
    return line
  })
}

async function rotateIfNeeded(options: Options) {
  const max = options.maxBytes ?? DEFAULT_MAX_BYTES
  const size = await stat(options.file).then(
    (info) => info.size,
    () => 0,
  )
  if (size >= max) {
    // The new file's first line chains to the rotated file's last line, so `verify` can walk
    // the whole stream across the boundary.
    await rename(options.file, `${options.file}.${new Date().toISOString().replaceAll(":", "-")}`).catch(() => {})
  }
  const cutoff = Date.now() - (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000
  for (const old of await rotated(options.file)) {
    const info = await stat(old).catch(() => undefined)
    if (info && info.mtimeMs < cutoff) await unlink(old).catch(() => {})
  }
}

type Listener = (line: string, event: EventName) => void
const listeners = new Set<Listener>()
/** Forwarders subscribe here and receive every line exactly as written. */
export function onLine(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Writes are serialised within a process and awaited by `flush()`, so a short-lived `lunos run`
// can't exit before its last events reach the file.
let queue: Promise<void> = Promise.resolve()

// Process-wide settings from the `audit` config block (redaction, rotation), applied to every
// write, including the residency and share writers that only know their file.
let defaults: Omit<Options, "file"> = {}
export function configure(next: Omit<Options, "file">) {
  defaults = next
}

export function write(input: Options, event: EventName, fields: Fields = {}, now = new Date()) {
  const options = { ...defaults, ...input, redact: [...(defaults.redact ?? []), ...(input.redact ?? [])] }
  const extra = options.redact
  const scrubbed = scrub(fields, extra)
  queue = queue
    .then(async () => {
      await mkdir(path.dirname(options.file), { recursive: true })
      // Read the last line before rotating: the fresh file's first line must chain to it.
      const before = tail(options.file).last
      await rotateIfNeeded(options)
      const line = appendChained(options.file, event, scrubbed, now, before)
      for (const listener of listeners) listener(line, event)
    })
    .catch((err) => {
      // A failing audit sink must not take down the user's session. It is reported, not
      // swallowed, so a persistently unwritable log is visible.
      console.error(`[audit] failed to write ${options.file}:`, err)
    })
  return queue
}

export function flush() {
  return queue
}

export type Verification =
  | { ok: true; lines: number; files: number }
  | { ok: false; file: string; line: number; reason: string }

/** Walks every file of the stream, oldest first, checking each line chains to the one before. */
export async function verify(file: string): Promise<Verification> {
  const all = await files(file)
  let previous: string | undefined
  let count = 0
  for (const current of all) {
    const lines = (await readFile(current, "utf8")).split("\n").filter(Boolean)
    for (const [index, line] of lines.entries()) {
      let parsed: any
      try {
        parsed = JSON.parse(line)
      } catch {
        return { ok: false, file: current, line: index + 1, reason: "not valid JSON" }
      }
      // v0 lines (before XCOD-103) carry no chain; the first v1 line after them chains to the last one.
      if (parsed.v !== undefined) {
        const expected = previous === undefined ? GENESIS : hashLine(previous)
        if (parsed.prev !== expected)
          return {
            ok: false,
            file: current,
            line: index + 1,
            reason: "does not chain to the line before it: a line was edited, removed or inserted",
          }
      }
      previous = line
      count++
    }
  }
  return { ok: true, lines: count, files: all.length }
}

/** Every line of the stream at or after `since`, oldest first. */
export async function read(file: string, since?: Date) {
  const out: Record<string, unknown>[] = []
  for (const current of await files(file)) {
    for (const line of (await readFile(current, "utf8")).split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line)
        if (since && new Date(parsed.timestamp) < since) continue
        out.push(parsed)
      } catch {}
    }
  }
  return out
}

const CSV_COLUMNS = [
  "timestamp",
  "event",
  "seq",
  "allowed",
  "providerID",
  "region",
  "host",
  "tool",
  "agent",
  "session",
  "command",
  "paths",
  "permission",
  "decision",
  "server",
  "source",
  "name",
  "key",
  "via",
  "version",
  "reason",
]

// A cell starting with = + - @ (or a tab/CR) runs as a formula in spreadsheet apps; command lines
// start with `-` all the time. Such cells are prefixed with ' and every cell is quoted as needed.
function cell(value: unknown) {
  if (value === undefined || value === null) return ""
  let text = Array.isArray(value) ? value.join(" ") : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function toCsv(rows: readonly Record<string, unknown>[]) {
  return (
    [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((column) => cell(row[column])).join(","))].join(
      "\r\n",
    ) + "\r\n"
  )
}
