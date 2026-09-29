export * as MemoryStore from "./store"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { MemoryKey } from "./key"

/**
 * Where memory lives, and the provenance ledger (XCOD-94).
 *
 * - Project memory: `.opencode/memory/graph/` in the worktree. A `.gitignore` of `*` is written
 *   into it, so the graph's database files are never committed; `lunos memory export` is the
 *   reviewable form.
 * - User memory: `memory/user/` in the Lunos data directory.
 * - The embedding model, downloaded once and shared: `memory/models/` in the data directory.
 *
 * Nothing here creates a directory until memory is on and something is remembered or recalled.
 */

export type Scope = "project" | "user"

export const DATASET = "lunos"

/**
 * The project memory belongs to: the git worktree, or the working directory when there is no git
 * repository (the instance reports its worktree as "/" then).
 */
export function projectRoot(ctx: { worktree: string; directory: string }) {
  return ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
}

export function dir(scope: Scope, worktree: string) {
  return scope === "project"
    ? path.join(worktree, ".opencode", "memory", "graph")
    : path.join(Global.Path.data, "memory", "user")
}

/** Where `lunos memory export` writes by default: one `<scope>/<id>.md` per fact. */
export function exportDir(worktree: string) {
  return path.join(worktree, ".opencode", "memory", "export")
}

/**
 * Where the TUI writes memory bundles (XCOD-132): the data directory, not the worktree, so a bundle
 * (which can hold user memory and forgotten-later facts) is never where the agent can read it or
 * where `git add` picks it up.
 */
export function bundles() {
  return path.join(Global.Path.data, "memory", "exports")
}

export function models() {
  return path.join(Global.Path.data, "memory", "models")
}

export function sidecarDir() {
  return path.join(Global.Path.data, "memory", "sidecar")
}

export async function ensure(scope: Scope, worktree: string) {
  const root = dir(scope, worktree)
  await fs.mkdir(root, { recursive: true })
  if (scope === "project") await fs.writeFile(path.join(root, ".gitignore"), "*\n", { flag: "a" }).catch(() => {})
  return root
}

/** Where a fact came from. Every fact carries one; recall shows it next to the fact. */
export interface Provenance {
  sessionID: string
  agent: string
  /** "user message", a worktree-relative file path, or a tool name. */
  source: string
  date: string
}

/**
 * Set on a fact that came in through `lunos memory import` (XCOD-133): what it was imported from
 * (`import:<file>#<sha256>`) and when. Imported memory is untrusted: recall labels it.
 */
export interface Imported {
  from: string
  date: string
}

/** XCOD-136: whether a person said it (or it was read from a file), or the agent concluded it. */
export type Kind = "observed" | "inferred"

export interface Fact {
  id: string
  datasetID: string
  text: string
  provenance: Provenance
  /** Imported facts only: the provenance the fact had where it came from. */
  origin?: Provenance
  imported?: Imported
  /** XCOD-136. Absent means active. An outdated fact is kept, but not recalled unless history is asked for. */
  status?: "active" | "outdated"
  kind?: Kind
  /** When the fact became true here. Absent means `provenance.date`. */
  valid_from?: string
  /** When it stopped being true: set when it is marked outdated. */
  invalid_at?: string
  /** The id of the fact that replaced it, if one did. */
  replaced_by?: string
  /** The id of the fact this one replaced. */
  replaces?: string
  /** A per-fact expiry date; otherwise `memory.retention.days` decides. */
  expires?: string
  /** Not held by the engine: removed from it when outdated, so its graph edges can't be recalled. */
  detached?: boolean
  /**
   * Runtime only, never stored: why the ledger's integrity check rejected this entry. A quarantined
   * fact is not recalled, and is listed by `lunos memory status` and `lunos memory verify`.
   */
  quarantined?: string
}

export function isActive(fact: Fact) {
  return (fact.status ?? "active") === "active"
}

export function ledgerFile(root: string) {
  return path.join(root, "facts.jsonl")
}

// ---------------------------------------------------------------------------------------------
// The ledger (XCOD-94, hardened in XCOD-136).
//
// Lunos's own record of every fact it stored: the text, the ids the engine gave it and its
// provenance. `list`, `show` and `export` read only this file, so reviewing memory never needs the
// engine running.
//
// Each line is one fact, as a JSON record plus two integrity fields:
// - `hash`: SHA-256 of the record's canonical JSON (keys sorted), without `hash` and `chain`;
// - `chain`: SHA-256 of the previous line's `chain` and this line's `hash` (the first line chains
//   from 64 zeros), so a line removed, inserted or moved breaks the chain after it.
// With `memory.encryption: "os-keychain"` the record is `{id, kid, enc}`: the fact's JSON sealed
// with AES-256-GCM under the keychain key (`MemoryKey`), with the id as associated data. The
// hashes are over that sealed record, so they reveal nothing about the text.
//
// On load, a line whose hash doesn't match, whose chain link doesn't match, that can't be parsed or
// that can't be decrypted is quarantined: listed with the reason, and never recalled. These are
// plain SHA-256s with no secret, so they catch damage and naive edits, not someone who rewrites the
// file and recomputes them; with encryption on, GCM makes an edited line undecryptable as well.

export const GENESIS = "0".repeat(64)

export type Mode = "off" | "os-keychain"

export interface Problem {
  /** 1-based line in facts.jsonl. */
  line: number
  /** The fact's id, when it could be read. */
  id?: string
  reason: string
}

interface Line {
  /** The line as stored. */
  raw: string
  /** The parsed record, when it parsed. */
  record?: Record<string, unknown>
  /** The fact, when it could be read (decrypted if needed). */
  fact?: Fact
  /** Set when the entry is quarantined. */
  problem?: string
  id?: string
}

export interface Ledger {
  facts: Fact[]
  problems: Problem[]
  /** Lines with no integrity fields: a ledger written before XCOD-136. Sealed when memory starts. */
  unsealed: number
  encrypted: number
  lines: Line[]
}

export const CHAIN_BREAK = "the ledger's hash chain breaks here"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

function sha256(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex")
}

export function hashOf(record: Record<string, unknown>) {
  const { hash: _h, chain: _c, ...rest } = record
  return sha256(canonical(rest))
}

export function link(previous: string, hash: string) {
  return sha256(previous + hash)
}

/** What gets stored for a fact: never the runtime-only `quarantined`. */
function stored(fact: Fact): Record<string, unknown> {
  const { quarantined: _q, ...rest } = fact
  return rest as Record<string, unknown>
}

function recover(raw: string, field: string) {
  return raw.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]{1,200})"`))?.[1]
}

async function readRaw(root: string) {
  const text = await fs.readFile(ledgerFile(root), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return ""
    throw e
  })
  return text.split("\n").filter((line) => line.trim())
}

/**
 * Read and check the whole ledger. Throws `MemoryKey.KeyError` when a line is encrypted and the key
 * is missing or different: memory must fail closed then, never look empty.
 */
export async function load(root: string): Promise<Ledger> {
  const raws = await readRaw(root)
  const lines: Line[] = raws.map((raw) => {
    try {
      const record = JSON.parse(raw)
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("not an object")
      return { raw, record, id: typeof record.id === "string" ? record.id : undefined }
    } catch {
      return { raw, id: recover(raw, "id"), problem: "the line is damaged: it is not valid JSON" }
    }
  })

  const encrypted = lines.filter((line) => typeof line.record?.enc === "string")
  if (encrypted.length) {
    const key = await MemoryKey.get()
    if (!key)
      throw new MemoryKey.KeyError(
        `Memory's ledger (${ledgerFile(root)}) is encrypted, and its key is missing from the OS keychain (${MemoryKey.describe()}). Nothing was read and nothing will be written. Restore the keychain entry to use this memory; without it, the ledger can't be recovered`,
      )
    const kid = MemoryKey.id(key)
    const other = encrypted.find((line) => line.record!.kid !== kid)
    if (other)
      throw new MemoryKey.KeyError(
        `Memory's ledger (${ledgerFile(root)}) was encrypted with key ${String(other.record!.kid)}, but the OS keychain (${MemoryKey.describe()}) holds key ${kid}. Nothing was read and nothing will be written. Restore the original keychain entry to use this memory`,
      )
    for (const line of encrypted) {
      try {
        const fact = JSON.parse(MemoryKey.open(key, String(line.record!.id), String(line.record!.enc))) as Fact
        if (fact.id !== line.record!.id) throw new Error("id mismatch")
        line.fact = fact
      } catch {
        line.problem = "the line could not be decrypted: it was edited or damaged"
      }
    }
  }
  for (const line of lines)
    if (line.record && line.record.enc === undefined) {
      const { hash: _h, chain: _c, ...fact } = line.record
      if (
        typeof fact.id === "string" &&
        typeof fact.text === "string" &&
        !!fact.provenance &&
        typeof fact.provenance === "object"
      )
        line.fact = fact as unknown as Fact
      else line.problem ??= "the line is damaged: it is not a fact"
    }

  // Integrity. A ledger with no integrity fields at all predates XCOD-136: nothing to check yet.
  const sealed = lines.filter((line) => typeof line.record?.hash === "string")
  const unsealed = sealed.length ? 0 : lines.length
  if (sealed.length) {
    // Chain bases a link may start from: the last good chain value, plus what a damaged line
    // claimed, so one bad line doesn't also quarantine the good line after it.
    let bases = [GENESIS]
    for (const line of lines) {
      const record = line.record
      const storedChain = typeof record?.chain === "string" ? record.chain : recover(line.raw, "chain")
      if (!record) {
        if (storedChain) bases = [...bases, storedChain]
        continue
      }
      const hash = typeof record.hash === "string" ? record.hash : undefined
      if (!hash) line.problem ??= "it has no integrity hash, but the rest of the ledger does"
      else if (hashOf(record) !== hash) line.problem ??= "its content doesn't match its integrity hash: it was edited"
      const ok = !!hash && !!storedChain && bases.some((base) => link(base, hash) === storedChain)
      if (!ok)
        line.problem ??= `${CHAIN_BREAK}: a line before it was removed or reordered, or this line was inserted`
      bases = ok
        ? [storedChain!]
        : [
            ...new Set([
              ...bases,
              ...(storedChain ? [storedChain] : []),
              ...(hash ? bases.map((base) => link(base, hash)) : []),
            ]),
          ]
    }
  }

  const facts: Fact[] = []
  const problems: Problem[] = []
  lines.forEach((line, index) => {
    if (line.problem) problems.push({ line: index + 1, id: line.fact?.id ?? line.id, reason: line.problem })
    if (line.fact) facts.push(line.problem ? { ...line.fact, quarantined: line.problem } : line.fact)
  })
  return { facts, problems, unsealed, encrypted: encrypted.length, lines }
}

/** Every fact in the ledger, quarantined ones marked. Reads only this file. */
export async function facts(root: string): Promise<Fact[]> {
  return (await load(root)).facts
}

async function keyFor(mode: Mode, ledger: Ledger) {
  if (mode !== "os-keychain") return undefined
  const existing = await MemoryKey.get()
  if (existing) return existing
  // load() already threw if an encrypted line exists without its key; this ledger has none.
  if (ledger.encrypted)
    throw new MemoryKey.KeyError(`The memory key is missing from the OS keychain (${MemoryKey.describe()})`)
  return MemoryKey.create()
}

function encode(fact: Fact, key: Buffer | undefined): Record<string, unknown> {
  if (!key) return stored(fact)
  return { id: fact.id, kid: MemoryKey.id(key), enc: MemoryKey.seal(key, fact.id, JSON.stringify(stored(fact))) }
}

function finish(record: Record<string, unknown>, previous: string) {
  const hash = hashOf(record)
  const chain = link(previous, hash)
  return { line: JSON.stringify({ ...record, hash, chain }), chain }
}

function lastChain(ledger: Ledger) {
  for (let index = ledger.lines.length - 1; index >= 0; index--) {
    const line = ledger.lines[index]
    const chain = typeof line.record?.chain === "string" ? line.record.chain : recover(line.raw, "chain")
    if (chain) return chain
  }
  return GENESIS
}

/** Append one fact. Seals a legacy ledger first. */
export async function add(root: string, fact: Fact, mode: Mode = "off") {
  const ledger = await load(root)
  if (ledger.unsealed) {
    await rewrite(root, (items) => [...items, fact], mode)
    return
  }
  const key = await keyFor(mode, ledger)
  const { line } = finish(encode(fact, key), lastChain(ledger))
  await fs.appendFile(ledgerFile(root), line + "\n")
}

export interface Rewritten {
  /** Lines quarantined only for a chain break, which this rewrite re-linked. */
  relinked: number
}

function stripIntegrity(record: Record<string, unknown>) {
  const { hash: _h, chain: _c, ...rest } = record
  return rest
}

/**
 * Rewrite the ledger through `change`, which gets every readable, unquarantined fact and returns
 * the facts to keep (changed or not, plus any new ones at the end). Entries that are quarantined for
 * their content, or unreadable, are kept exactly as they are with their old hash, so a rewrite never
 * launders an edited line: it stays quarantined until it is forgotten (`drop`) or resealed
 * (`reseal`). A line quarantined only for a chain break is re-linked (and counted in `relinked`):
 * the chain detects changes between Lunos's own writes. Unchanged lines keep their record; lines in
 * the other encoding are re-encoded, which is how turning encryption on or off takes effect.
 */
export async function rewrite(
  root: string,
  change: (facts: Fact[]) => Fact[],
  mode: Mode = "off",
  options: { drop?: ReadonlySet<string>; reseal?: boolean } = {},
): Promise<Rewritten> {
  const ledger = await load(root)
  const key = await keyFor(mode, ledger)
  const good = ledger.lines.filter((line) => line.fact && !line.problem)
  const kept = change(good.map((line) => line.fact!))
  const byID = new Map(kept.map((fact) => [fact.id, fact]))
  const out: string[] = []
  let previous = GENESIS
  let relinked = 0
  for (const line of ledger.lines) {
    if (line.id && options.drop?.has(line.id)) continue
    if (line.problem && !(options.reseal && line.fact)) {
      if (!line.record) {
        out.push(line.raw)
        continue
      }
      if (line.problem.startsWith(CHAIN_BREAK)) relinked++
      const chain = link(previous, String(line.record.hash ?? ""))
      out.push(JSON.stringify({ ...line.record, chain }))
      previous = chain
      continue
    }
    const fact = line.problem ? line.fact! : byID.get(line.fact!.id)
    if (!fact) continue
    byID.delete(fact.id)
    const sameEncoding = key ? typeof line.record?.enc === "string" : line.record?.enc === undefined
    const unchanged =
      !line.problem &&
      sameEncoding &&
      typeof line.record?.hash === "string" &&
      canonical(stored(fact)) === canonical(stored(line.fact!))
    const next = finish(unchanged ? stripIntegrity(line.record!) : encode(fact, key), previous)
    out.push(next.line)
    previous = next.chain
  }
  for (const fact of byID.values()) {
    const next = finish(encode(fact, key), previous)
    out.push(next.line)
    previous = next.chain
  }
  const file = ledgerFile(root)
  await fs.writeFile(file + ".tmp", out.map((line) => line + "\n").join(""))
  await fs.rename(file + ".tmp", file)
  return { relinked }
}

export async function remove(root: string, id: string, mode: Mode = "off") {
  return rewrite(root, (items) => items.filter((fact) => fact.id !== id), mode, { drop: new Set([id]) })
}

/** Change one fact in place. False if no readable, unquarantined fact has that id. */
export async function update(root: string, id: string, patch: (fact: Fact) => Fact, mode: Mode = "off") {
  let found = false
  await rewrite(
    root,
    (items) =>
      items.map((fact) => {
        if (fact.id !== id) return fact
        found = true
        return patch(fact)
      }),
    mode,
  )
  return found
}

/**
 * Bring the ledger in line with the configured mode when memory starts: seal a legacy ledger, and
 * encrypt or decrypt it after `memory.encryption` changed. A no-op when it already matches.
 */
export async function prepare(root: string, mode: Mode) {
  const ledger = await load(root)
  if (!ledger.lines.length) return
  const readable = ledger.lines.filter((line) => line.fact && !line.problem)
  const mismatched =
    mode === "os-keychain"
      ? readable.some((line) => line.record?.enc === undefined)
      : readable.some((line) => typeof line.record?.enc === "string")
  if (!ledger.unsealed && !mismatched) return
  await rewrite(root, (items) => items, mode)
}
