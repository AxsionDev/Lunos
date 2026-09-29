export * as MemoryImport from "./import"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { Effect } from "effect"
import { AuditLog } from "@/audit/log"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "."
import { MemoryBackend } from "./backend"
import { MemoryBundle } from "./bundle"
import { MemoryGuard } from "./guard"
import { MemoryModel } from "./model"
import { MemoryNotes } from "./notes"
import { MemoryStore } from "./store"

/**
 * `lunos memory import` (XCOD-133). Import is a write path from an untrusted source (OWASP ASI06):
 * a checksum or a passphrase proves where a bundle came from, not that what it says is safe.
 *
 * The pipeline, in order, and nothing is written before the last step:
 * 1. **Read.** A Lunos bundle (folder, `.zip` or `.zip.enc`), a Markdown file or folder, or other
 *    agents' files (`AGENTS.md`, `CLAUDE.md`, Claude Code auto-memory notes).
 * 2. **Verify** a bundle: a format this Lunos understands, and the SHA-256 of every file in
 *    `manifest.json`, checked after decrypting (CBC is not authenticated). Any mismatch, missing or
 *    unlisted file, or count that disagrees with the facts refuses the whole bundle.
 * 3. **Screen** every fact and note paragraph with `MemoryGuard.check`, the screens `memory_remember`
 *    uses: size, secrets, instruction-shaped text.
 * 4. **Dedupe** against what memory holds: exact text, and near-duplicates flagged.
 * 5. **Conflicts:** the same subject with a different ending, shown next to the fact it contradicts.
 * 6. **Preview** (`plan`): new / duplicate / conflict / rejected, each with a reason.
 * 7. **Store** (`run` with approval): the fact's source becomes `import:<file>#<sha256>`, its original
 *    provenance is kept as `origin`, and it is flagged `imported`.
 *
 * What a bundle says beyond its facts is not trusted: `graph.json` is never imported (the engine
 * re-extracts the graph from the facts), and `index/` engine files are never copied (they would
 * skip every screen above). Hand-written notes are restored as note files, because that is what
 * they are; each of their paragraphs is screened like a fact first.
 */

export type Status = "new" | "duplicate" | "conflict" | "rejected"

export interface Candidate {
  kind: "fact" | "note"
  /** The scope the input asks for. The target (`--scope`) overrides it. */
  scope: MemoryStore.Scope
  text: string
  /** The provenance the fact had where it came from, when the input records one. */
  origin?: MemoryStore.Provenance
  /** Where in the input it is, for the preview: `facts.jsonl:3`, `notes/team.md`, `AGENTS.md`. */
  file: string
  /** `import:<file>#<sha256>`: becomes the stored fact's source. */
  from: string
  /** Notes only: the file in `.opencode/memory/` it goes into. */
  note?: string
}

/** A note file to restore: its original text (so headings survive) and its marker. */
export interface NoteFile {
  name: string
  text: string
  from: string
  origin?: MemoryStore.Provenance
}

export interface Source {
  kind: "bundle" | "markdown"
  /** The input's file or folder name. */
  label: string
  /** SHA-256 of the input: the file, a bundle folder's manifest.json, or a Markdown folder's listing. */
  sha256: string
  candidates: Candidate[]
  notes: NoteFile[]
  bundle?: {
    format: string
    created: string
    counts: MemoryBundle.Manifest["counts"]
    encrypted: boolean
  }
  /** Things the preview should say: graph and index not imported, lines skipped. */
  warnings: string[]
}

export class RefusedError extends Error {
  override name = "MemoryImportRefused"
}

export class PassphraseError extends Error {
  override name = "MemoryImportPassphrase"
}

// ---------------------------------------------------------------------------------------------
// Reading.

/** Refuse inputs whose files add up to more than this: a zip bomb, or not memory at all. */
const MAX_BYTES = 1024 * 1024 * 1024
const MAX_FILES = 100_000

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ENC_MAGIC = Buffer.from("Salted__")

export function sha256(data: Uint8Array | string) {
  return crypto.createHash("sha256").update(data).digest("hex")
}

function posix(file: string) {
  return file.split(path.sep).join("/")
}

/** A path from a manifest or zip entry: relative, no `..`, no backslashes, no drive letters. */
function safeRelative(file: string) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    !file.startsWith("/") &&
    !file.includes("\\") &&
    !/^[A-Za-z]:/.test(file) &&
    !file.split("/").some((part) => part === ".." || part === "." || part === "")
  )
}

async function walk(dir: string) {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name)
    if (entry.isSymbolicLink())
      throw new RefusedError(`${path.relative(dir, file)} is a symbolic link; refusing to follow it`)
    if (entry.isFile()) out.push(file)
  }
  if (out.length > MAX_FILES) throw new RefusedError(`${dir} holds more than ${MAX_FILES} files`)
  return out.toSorted()
}

async function unzip(data: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(data))
  const files = new Map<string, Uint8Array>()
  try {
    const entries = await reader.getEntries()
    if (entries.length > MAX_FILES) throw new RefusedError(`The archive holds more than ${MAX_FILES} files`)
    let total = 0
    for (const entry of entries) {
      if (entry.directory) continue
      if (!safeRelative(entry.filename)) throw new RefusedError(`The archive has an unsafe path: ${entry.filename}`)
      if (files.has(entry.filename)) throw new RefusedError(`The archive lists ${entry.filename} twice`)
      total += entry.uncompressedSize
      if (total > MAX_BYTES) throw new RefusedError("The archive unpacks to more than 1 GiB; refusing it")
      const bytes = await entry.getData!(new Uint8ArrayWriter())
      if (bytes.byteLength !== entry.uncompressedSize) throw new RefusedError(`${entry.filename} is damaged`)
      files.set(entry.filename, bytes)
    }
  } catch (error) {
    if (error instanceof RefusedError) throw error
    throw new RefusedError(`Not a readable zip archive: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await reader.close().catch(() => {})
  }
  return files
}

async function folder(dir: string) {
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (const file of await walk(dir)) {
    const data = new Uint8Array(await fs.readFile(file))
    total += data.byteLength
    if (total > MAX_BYTES) throw new RefusedError(`${dir} holds more than 1 GiB; refusing it`)
    files.set(posix(path.relative(dir, file)), data)
  }
  return files
}

export interface ReadOptions {
  /** Import other agents' files as facts instead of notes. */
  asFacts?: boolean
  /** Asked for only when the input is an encrypted bundle. */
  passphrase?: () => Promise<string | undefined>
}

/** Read and verify an input. Throws `RefusedError` for anything that isn't safe to plan from. */
export async function read(input: string, options: ReadOptions = {}): Promise<Source> {
  const stat = await fs.lstat(input).catch(() => undefined)
  if (!stat) throw new RefusedError(`${input} does not exist`)
  if (stat.isSymbolicLink()) throw new RefusedError(`${input} is a symbolic link; pass the file it points to`)
  const label = path.basename(input)
  if (stat.isDirectory()) {
    if (await fs.stat(path.join(input, "manifest.json")).catch(() => undefined)) {
      const files = await folder(input)
      return bundle(files, {
        label,
        sha256: sha256(files.get("manifest.json")!),
        encrypted: false,
        asFacts: options.asFacts,
      })
    }
    return markdownFolder(input, options)
  }
  if (!stat.isFile()) throw new RefusedError(`${input} is not a file or folder`)
  if (stat.size > MAX_BYTES) throw new RefusedError(`${input} is larger than 1 GiB; refusing it`)
  const data = new Uint8Array(await fs.readFile(input))
  const head = Buffer.from(data.subarray(0, 8))
  if (head.equals(ENC_MAGIC)) {
    const passphrase = await options.passphrase?.()
    if (!passphrase) throw new PassphraseError(`${label} is encrypted: a passphrase is needed to import it`)
    // Copied: Buffer.concat can hand back a view into a shared pool, and the zip reader reads the
    // whole underlying ArrayBuffer.
    const plain = new Uint8Array(MemoryBundle.decrypt(data, passphrase))
    return bundle(await unzip(plain), { label, sha256: sha256(data), encrypted: true, asFacts: options.asFacts })
  }
  if (head.subarray(0, 4).equals(ZIP_MAGIC))
    return bundle(await unzip(data), { label, sha256: sha256(data), encrypted: false, asFacts: options.asFacts })
  if (!/\.(md|markdown)$/i.test(label))
    throw new RefusedError(`${label} is not a Lunos memory bundle (folder, .zip or .zip.enc) or a Markdown file`)
  const text = new TextDecoder().decode(data)
  const from = `import:${label}#${sha256(data)}`
  const parsed = markdown({ file: label, path: input, text, from, asFacts: options.asFacts })
  return {
    kind: "markdown",
    label,
    sha256: sha256(data),
    candidates: parsed.candidates,
    notes: parsed.notes,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------------------------
// Bundles.

const FORMAT = /^lunos-memory\/(\d+)$/

/**
 * Files a file manager drops into any folder it opens. Never read, so tolerated when unlisted:
 * otherwise opening a bundle folder in Finder would make it unimportable.
 */
const OS_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"])

function isProvenance(value: unknown): value is MemoryStore.Provenance {
  const p = value as Record<string, unknown> | null
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.sessionID === "string" &&
    typeof p.agent === "string" &&
    typeof p.source === "string" &&
    typeof p.date === "string"
  )
}

function provenanceOf(p: MemoryStore.Provenance): MemoryStore.Provenance {
  return { sessionID: p.sessionID, agent: p.agent, source: p.source, date: p.date }
}

/** Only the fields an importer reads; unknown fields are ignored, as SCHEMA.md promises. */
function bundleFact(line: string, index: number): MemoryBundle.Fact {
  const bad = (why: string) => new RefusedError(`facts.jsonl line ${index + 1} is not a valid fact: ${why}`)
  let value: Record<string, unknown>
  try {
    value = JSON.parse(line)
  } catch {
    throw bad("not JSON")
  }
  if (!value || typeof value !== "object") throw bad("not an object")
  if (typeof value.text !== "string" || !value.text) throw bad("no text")
  if (value.scope !== "project" && value.scope !== "user") throw bad("scope must be project or user")
  if (!isProvenance(value.provenance)) throw bad("provenance needs sessionID, agent, source and date")
  if (value.origin !== undefined && !isProvenance(value.origin)) throw bad("origin is not a provenance")
  return value as unknown as MemoryBundle.Fact
}

function bundle(
  files: Map<string, Uint8Array>,
  input: { label: string; sha256: string; encrypted: boolean; asFacts?: boolean },
): Source {
  const raw = files.get("manifest.json")
  if (!raw) throw new RefusedError(`${input.label} has no manifest.json: not a Lunos memory bundle`)
  let manifest: MemoryBundle.Manifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new RefusedError("manifest.json is not valid JSON")
  }
  const format = String(manifest?.format ?? "")
  const version = format.match(FORMAT)
  if (!version) throw new RefusedError(`${input.label} is not a Lunos memory bundle (format "${format}")`)
  if (version[1] !== "1")
    throw new RefusedError(
      `${input.label} is format ${format}, which this Lunos can't read (it reads ${MemoryBundle.FORMAT}). Update Lunos to import it`,
    )
  if (!Array.isArray(manifest.files)) throw new RefusedError("manifest.json has no file list")

  // Every listed file present with its size and SHA-256; nothing present that isn't listed.
  const problems: string[] = []
  const listed = new Set<string>()
  for (const entry of manifest.files) {
    if (!safeRelative(entry?.path)) {
      problems.push(`unsafe path ${JSON.stringify(entry?.path)}`)
      continue
    }
    listed.add(entry.path)
    const data = files.get(entry.path)
    if (!data) problems.push(`${entry.path} is missing`)
    else if (data.byteLength !== entry.bytes || sha256(data) !== entry.sha256)
      problems.push(`${entry.path} does not match its checksum`)
  }
  for (const file of files.keys())
    if (file !== "manifest.json" && !listed.has(file) && !OS_JUNK.has(path.posix.basename(file)))
      problems.push(`${file} is not in the manifest`)
  if (problems.length)
    throw new RefusedError(
      `Nothing was imported: ${input.label} failed verification, so none of it can be trusted:\n${problems.map((item) => `  ${item}`).join("\n")}`,
    )

  const text = (file: string) =>
    files.has(file) ? new TextDecoder("utf-8", { fatal: true }).decode(files.get(file)) : ""
  const facts = text("facts.jsonl")
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.trim())
    .map((item) => bundleFact(item.line, item.index))
  const noteNames = [...files.keys()].filter((file) => /^notes\/[^/]+\.md$/.test(file)).toSorted()

  // manifest.json isn't hashed in itself: check that what it claims agrees with what's there.
  const counts = manifest.counts
  const byScope = (scope: MemoryStore.Scope) => facts.filter((item) => item.scope === scope).length
  if (
    counts?.facts?.total !== facts.length ||
    counts.facts.project !== byScope("project") ||
    counts.facts.user !== byScope("user") ||
    counts.notes !== noteNames.length
  )
    throw new RefusedError("Nothing was imported: manifest.json's counts don't match the bundle's facts and notes")
  if (files.has("graph.json"))
    try {
      JSON.parse(text("graph.json"))
    } catch {
      throw new RefusedError("graph.json is not valid JSON")
    }

  const from = `import:${input.label}#${input.sha256}`
  const warnings: string[] = []
  if (counts.entities || counts.relations)
    warnings.push(
      `The bundle's graph (${counts.entities} entities, ${counts.relations} relationships) is not imported: memory re-extracts it from the facts`,
    )
  if ([...files.keys()].some((file) => file.startsWith("index/")))
    warnings.push("The bundle's engine index files are not imported: every fact is re-embedded here instead")

  const candidates: Candidate[] = []
  const notes: NoteFile[] = []
  const fromNotes = (item: MemoryBundle.Fact) => item.provenance.sessionID === MemoryNotes.SESSION
  const noteSources = new Set(noteNames.map((file) => `.opencode/memory/${file.slice("notes/".length)}`))
  facts.forEach((item, index) => {
    // A note's facts come back with its file, unless the file isn't in the bundle or notes are
    // imported as facts.
    if (fromNotes(item) && !input.asFacts && noteSources.has(item.provenance.source)) return
    candidates.push({
      kind: "fact",
      scope: item.scope,
      text: item.text.trim(),
      // A fact that was itself imported keeps the provenance it had first.
      origin: provenanceOf(item.origin ?? item.provenance),
      file: `facts.jsonl:${index + 1}`,
      from,
    })
  })
  if (!input.asFacts)
    for (const file of noteNames) {
      const name = file.slice("notes/".length)
      const source = `.opencode/memory/${name}`
      const dated = facts
        .filter((item) => fromNotes(item) && item.provenance.source === source)
        .map((item) => item.provenance.date)
        .toSorted()
      const origin = dated.length
        ? { sessionID: MemoryNotes.SESSION, agent: "user", source, date: dated[0] }
        : undefined
      const note: NoteFile = { name: noteName(name), text: text(file), from, origin }
      notes.push(note)
      for (const paragraph of MemoryNotes.paragraphs(note.text))
        candidates.push({ kind: "note", scope: "project", text: paragraph, origin, file, from, note: note.name })
    }
  return {
    kind: "bundle",
    label: input.label,
    sha256: input.sha256,
    candidates,
    notes,
    bundle: { format, created: String(manifest.created ?? ""), counts, encrypted: input.encrypted },
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// Markdown and other agents' files.

const AGENT_FILES: Record<string, string> = {
  "agents.md": "agents-md.md",
  "claude.md": "claude-md.md",
  "claude.local.md": "claude-local-md.md",
}

const CLAUDE_MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"])

/** A name for `.opencode/memory/`. Never `AGENTS.md` or `CLAUDE.md`: other tools load those as instructions. */
export function noteName(name: string) {
  const base = path.basename(name)
  const mapped = AGENT_FILES[base.toLowerCase()] ?? base
  const safe = mapped.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "")
  const md = /\.md$/i.test(safe) ? safe : `${safe}.md`
  return AGENT_FILES[md.toLowerCase()] ?? md
}

function frontmatter(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { fields: {} as Record<string, string>, body: text }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/)
    if (pair) fields[pair[1]] = pair[2].trim()
  }
  return { fields, body: text.slice(match[0].length) }
}

/** Whether a file is another agent's memory or instructions, imported as a note by default. */
export function isAgentFile(file: string, fields: Record<string, string>) {
  const base = path.basename(file).toLowerCase()
  if (base in AGENT_FILES) return true
  // Claude Code auto-memory: ~/.claude/projects/<project>/memory/*.md, each with name/type frontmatter.
  if (/(^|\/)\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/i.test(posix(file))) return true
  return !!fields.name && CLAUDE_MEMORY_TYPES.has(fields.type ?? "")
}

/** Top-level `- ` bullets, with their indented continuation lines. */
function bullets(body: string) {
  const out: string[] = []
  let current: string[] | undefined
  for (const line of body.split(/\r?\n/)) {
    if (/^[-*] /.test(line)) {
      if (current) out.push(current.join("\n").trim())
      current = [line.slice(2)]
    } else if (current && /^\s+\S/.test(line)) current.push(line.trim())
    else if (current) {
      out.push(current.join("\n").trim())
      current = undefined
    }
  }
  if (current) out.push(current.join("\n").trim())
  return out.filter(Boolean)
}

function unquote(value: string) {
  if (!value.startsWith('"')) return value
  try {
    return String(JSON.parse(value))
  } catch {
    return value
  }
}

/**
 * One Markdown file. Our own `--format markdown` export (frontmatter with id, scope, source,
 * session and date) is one fact with that provenance as its origin. Other agents' files are notes
 * unless `asFacts`. Anything else: one fact per top-level `- ` bullet, or the whole file as one.
 */
export function markdown(input: { file: string; path: string; text: string; from: string; asFacts?: boolean }) {
  const { fields, body } = frontmatter(input.text.replace(/^﻿/, ""))
  const candidates: Candidate[] = []
  const notes: NoteFile[] = []
  const base = { file: input.file, from: input.from }
  if (
    fields.id &&
    fields.source &&
    fields.session &&
    fields.date &&
    (fields.scope === "project" || fields.scope === "user")
  ) {
    const text = body.trim()
    if (text)
      candidates.push({
        ...base,
        kind: "fact",
        scope: fields.scope,
        text,
        origin: {
          sessionID: fields.session,
          agent: fields.agent ?? "",
          source: unquote(fields.source),
          date: fields.date,
        },
      })
    return { candidates, notes }
  }
  if (isAgentFile(input.path, fields) && !input.asFacts) {
    const note: NoteFile = { name: noteName(input.file), text: body, from: input.from }
    notes.push(note)
    for (const paragraph of MemoryNotes.paragraphs(body))
      candidates.push({ ...base, kind: "note", scope: "project", text: paragraph, note: note.name })
    return { candidates, notes }
  }
  const items = bullets(body)
  const texts = items.length
    ? items
    : [
        body
          .split(/\r?\n/)
          .filter((line) => !/^#+\s/.test(line))
          .join("\n")
          .trim(),
      ].filter(Boolean)
  for (const text of texts) candidates.push({ ...base, kind: "fact", scope: "project", text })
  return { candidates, notes }
}

async function markdownFolder(dir: string, options: ReadOptions): Promise<Source> {
  const files = (await walk(dir)).filter((file) => /\.(md|markdown)$/i.test(file))
  if (!files.length) throw new RefusedError(`${dir} holds no Markdown files and no manifest.json`)
  const candidates: Candidate[] = []
  const notes: NoteFile[] = []
  const listing: string[] = []
  const names = new Set<string>()
  for (const file of files) {
    const data = await fs.readFile(file)
    const relative = posix(path.relative(dir, file))
    const hash = sha256(data)
    listing.push(`${relative}\0${hash}`)
    const parsed = markdown({
      file: relative,
      path: file,
      text: data.toString("utf8"),
      from: `import:${relative}#${hash}`,
      asFacts: options.asFacts,
    })
    // Two files with the same name in different folders become two notes.
    for (const note of parsed.notes) {
      let name = note.name
      if (names.has(name)) name = name.replace(/\.md$/, `-${hash.slice(0, 8)}.md`)
      names.add(name)
      for (const item of parsed.candidates) if (item.note === note.name) item.note = name
      note.name = name
    }
    candidates.push(...parsed.candidates)
    notes.push(...parsed.notes)
  }
  return {
    kind: "markdown",
    label: path.basename(dir),
    sha256: sha256(listing.join("\n")),
    candidates,
    notes,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------------------------
// Planning: the preview.

export interface Row {
  /** Stable for the same input and memory, so a preview's approvals can be applied. */
  key: string
  kind: "fact" | "note"
  scope: MemoryStore.Scope
  status: Status
  reason: string
  text: string
  file: string
  note?: string
  /** A near-duplicate: shown as a duplicate, but written if a person approves it. */
  near?: boolean
  /** What it duplicates or contradicts. */
  other?: { id?: string; text: string }
}

export interface Plan {
  source: Omit<Source, "candidates" | "notes">
  rows: Row[]
  counts: Record<Status, number>
  /** Set when writing everything new would pass `memory.limits.max_facts`: the import stops at preview. */
  limit?: string
}

export interface Existing {
  facts: Record<MemoryStore.Scope, MemoryStore.Fact[]>
  /** The note files in `.opencode/memory/`. */
  notes: { name: string; text: string }[]
}

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

function jaccard(a: Set<string>, b: Set<string>) {
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  return shared / (a.size + b.size - shared || 1)
}

const NEAR = 0.85

/**
 * The same subject with a different value: both start with the same words (at least three, and at
 * least half the shorter one) and then say something different. "The billing service owns the
 * invoices table" against "... owns the payments table".
 */
function conflicts(a: string[], b: string[]) {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  const shorter = Math.min(a.length, b.length)
  return prefix >= 3 && prefix >= shorter / 2 && prefix < Math.max(a.length, b.length) && a.join(" ") !== b.join(" ")
}

function rowKey(item: Candidate, scope: MemoryStore.Scope) {
  return sha256(`${item.kind}\n${scope}\n${item.note ?? ""}\n${item.text}`).slice(0, 16)
}

export function plan(
  source: Source,
  input: { existing: Existing; limits: MemoryBackend.Limits; target?: MemoryStore.Scope },
): Plan {
  type Known = { id?: string; text: string; words: string[]; set: Set<string> }
  const known = (id: string | undefined, text: string): Known => {
    const w = words(text)
    return { id, text, words: w, set: new Set(w) }
  }
  const pool: Record<MemoryStore.Scope, Known[]> = {
    project: input.existing.facts.project.map((fact) => known(fact.id, fact.text)),
    user: input.existing.facts.user.map((fact) => known(fact.id, fact.text)),
  }
  const exact: Record<MemoryStore.Scope, Map<string, string>> = {
    project: new Map(input.existing.facts.project.map((fact) => [fact.text, fact.id])),
    user: new Map(input.existing.facts.user.map((fact) => [fact.text, fact.id])),
  }
  const inNotes = new Map<string, string>()
  for (const note of input.existing.notes)
    for (const paragraph of MemoryNotes.paragraphs(note.text)) inNotes.set(paragraph, note.name)
  const seen = new Set<string>()

  const rows: Row[] = []
  for (const item of source.candidates) {
    const scope = input.target ?? item.scope
    const row = (status: Status, reason: string, extra: Partial<Row> = {}): Row => ({
      key: rowKey(item, scope),
      kind: item.kind,
      scope,
      status,
      reason,
      text: item.text,
      file: item.file,
      ...(item.note ? { note: item.note } : {}),
      ...extra,
    })
    if (item.kind === "note" && scope !== "project") {
      rows.push(
        row("rejected", "hand-written notes are project memory; use --as-facts to import them into user memory"),
      )
      continue
    }
    const refusal = MemoryGuard.check(item.text, input.limits)
    if (refusal) {
      rows.push(row("rejected", refusal))
      continue
    }
    const id = exact[scope].get(item.text)
    if (id) {
      rows.push(row("duplicate", `already in ${scope} memory`, { other: { id, text: item.text } }))
      continue
    }
    if (item.kind === "note" && inNotes.has(item.text)) {
      rows.push(row("duplicate", `already in the note ${inNotes.get(item.text)}`, { other: { text: item.text } }))
      continue
    }
    const dedupe = `${scope}\n${item.text}`
    if (seen.has(dedupe)) {
      rows.push(row("duplicate", "appears earlier in this import"))
      continue
    }
    seen.add(dedupe)
    const mine = known(undefined, item.text)
    const near = pool[scope].find((other) => jaccard(mine.set, other.set) >= NEAR)
    if (near) {
      rows.push(
        row("duplicate", `near-duplicate of ${near.id ? `${near.id} ` : "an earlier row "}in ${scope} memory`, {
          near: true,
          other: { id: near.id, text: near.text },
        }),
      )
      continue
    }
    const against = pool[scope].find((other) => conflicts(mine.words, other.words))
    if (against) {
      rows.push(
        row("conflict", `says something different about the same subject as ${against.id ?? "an earlier row"}`, {
          other: { id: against.id, text: against.text },
        }),
      )
      pool[scope].push(mine)
      continue
    }
    pool[scope].push(mine)
    rows.push(row("new", item.kind === "note" ? `new paragraph for the note ${item.note}` : `new ${scope} fact`))
  }

  const counts: Record<Status, number> = { new: 0, duplicate: 0, conflict: 0, rejected: 0 }
  for (const item of rows) counts[item.status]++
  const { candidates: _c, notes: _n, ...summary } = source
  const result: Plan = { source: summary, rows, counts }
  result.limit = limitProblem(
    rows.filter((item) => item.status === "new"),
    input.existing,
    input.limits,
  )
  return result
}

function limitProblem(rows: Row[], existing: Existing, limits: MemoryBackend.Limits) {
  for (const scope of ["project", "user"] as const) {
    const adding = rows.filter((item) => item.scope === scope).length
    const have = existing.facts[scope].length
    if (adding && have + adding > limits.maxFacts)
      return `Importing would put ${have + adding} facts in ${scope} memory, over the ${limits.maxFacts} allowed (memory.limits.max_facts). Nothing was imported; forget some facts or raise the limit first`
  }
}

// ---------------------------------------------------------------------------------------------
// The shared entry points for the CLI and the TUI.

export interface Options {
  path: string
  target?: MemoryStore.Scope
  asFacts?: boolean
  passphrase?: () => Promise<string | undefined>
}

export interface Preview extends Plan {
  /** The model that extracts each written fact's entities, and how many calls that is. */
  extraction: { model: string; source: string; calls: number }
  /** Embeddings are computed on this machine: no calls leave it. */
  embedding: { model: string; remoteCalls: number }
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Read, verify and plan, without starting memory and without writing a byte. The embedding and
 * extraction models are checked against the residency policy first: every written fact is embedded
 * and extracted again, so a denied model stops the import before anything is read.
 */
const planned = Effect.fn("MemoryImport.planned")(function* (options: Options & { parent: MemoryModel.Model }) {
  const memory = yield* Memory.Service
  const config = yield* Config.Service
  const cfg = yield* config.get()
  const ctx = yield* InstanceState.context
  const worktree = MemoryStore.projectRoot(ctx)
  const residency = AuditLog.residency(cfg)
  const chosen = yield* Effect.try({
    try: () => {
      MemoryModel.checkEmbedding(cfg.memory, residency)
      const out = MemoryModel.resolve({ memory: cfg.memory, small_model: cfg.small_model, parent: options.parent })
      MemoryModel.checkResidency(out, residency)
      return out
    },
    catch: toError,
  })
  const source = yield* Effect.tryPromise({
    try: () =>
      read(path.resolve(ctx.directory, options.path), { asFacts: options.asFacts, passphrase: options.passphrase }),
    catch: toError,
  })
  const existing: Existing = {
    facts: { project: yield* memory.facts("project"), user: yield* memory.facts("user") },
    notes: yield* Effect.promise(() => MemoryNotes.read(worktree)),
  }
  const limits = {
    maxFacts: cfg.memory?.limits?.max_facts ?? MemoryBackend.DEFAULT_LIMITS.maxFacts,
    maxFactChars: cfg.memory?.limits?.max_fact_chars ?? MemoryBackend.DEFAULT_LIMITS.maxFactChars,
  }
  const result = plan(source, { existing, limits, target: options.target })
  const recalled = cfg.memory?.scope ?? ["project"]
  for (const scope of ["project", "user"] as const)
    if (!recalled.includes(scope) && result.rows.some((row) => row.scope === scope && row.status !== "rejected"))
      result.source.warnings = [
        ...result.source.warnings,
        `Rows go to ${scope} memory, which memory.scope doesn't include: they would be stored but not recalled until it does`,
      ]
  const shown: Preview = {
    ...result,
    extraction: {
      model: `${chosen.model.providerID}/${chosen.model.modelID}`,
      source: chosen.source,
      calls: result.counts.new,
    },
    embedding: { model: cfg.memory?.embedding ?? "local", remoteCalls: 0 },
  }
  return { preview: shown, source, existing, limits, worktree }
})

/** The preview: what an import would do. Writes nothing and starts nothing. */
export const preview = Effect.fn("MemoryImport.preview")(function* (options: Options & { parent: MemoryModel.Model }) {
  return (yield* planned(options)).preview
})

export interface Result {
  preview: Preview
  /** Facts stored, not counting note paragraphs. */
  facts: number
  /** Note paragraphs approved, and the note files written for them. */
  noteParagraphs: number
  notes: string[]
  failed: { text: string; reason: string }[]
}

/**
 * The note file's new text: the marker, then only what was screened. Approved paragraphs, and
 * single-line headings that pass the guard. Everything else is dropped: the notes sync trusts note
 * files, so a block the preview never showed (a heading with poison under it, a second marker) must
 * not get in.
 */
export function noteText(note: NoteFile, keep: Set<string>, date: string, limits: { maxFactChars: number }) {
  const blocks = note.text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => keep.has(block) || (/^#{1,6} [^\n]*$/.test(block) && !MemoryGuard.check(block, limits)))
  const marker = MemoryNotes.marker({
    imported: { from: note.from, date },
    ...(note.origin ? { origin: note.origin } : {}),
  })
  return [marker, ...blocks].join("\n\n") + "\n"
}

async function writeNote(dir: string, name: string, text: string) {
  await fs.mkdir(dir, { recursive: true })
  let target = path.join(dir, name)
  const current = await fs.readFile(target, "utf8").catch(() => undefined)
  if (current === text) return undefined
  // Never overwrite a note a person wrote.
  if (current !== undefined) target = path.join(dir, name.replace(/\.md$/, `.imported-${sha256(text).slice(0, 8)}.md`))
  await fs.writeFile(target, text, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  return path.basename(target)
}

/**
 * Record an approved import in the audit log: the counts and the SHA-256 of what was read, never
 * text or paths. Also called when an approved import had nothing to write (all duplicates or all
 * rejected), so a bundle that was entirely poison still leaves a trace. Previews are not recorded.
 */
export function audit(
  shown: Preview,
  written: { facts: number; notes: number; noteParagraphs: number; failed: number; scopes: MemoryStore.Scope[] } = {
    facts: 0,
    notes: 0,
    noteParagraphs: 0,
    failed: 0,
    scopes: [],
  },
) {
  AuditLog.emit("memory.import", {
    kind: shown.source.kind,
    sha256: shown.source.sha256,
    encrypted: shown.source.bundle?.encrypted ?? false,
    facts: written.facts,
    notes: written.notes,
    note_paragraphs: written.noteParagraphs,
    new: shown.counts.new,
    duplicate: shown.counts.duplicate,
    conflict: shown.counts.conflict,
    rejected: shown.counts.rejected,
    failed: written.failed,
    scopes: written.scopes,
  })
}

/**
 * Import for real. Re-reads and re-plans (never trusting a preview a client holds), then writes the
 * rows that are `new`, plus `conflict` and near-duplicate rows when `includeConflicts`. With `accept`
 * given, only the rows it names are written. Rejected rows and exact duplicates never are. Refused
 * outright, before anything is written, when the rows would pass `memory.limits.max_facts`.
 */
export const run = Effect.fn("MemoryImport.run")(function* (
  options: Options & { parent: MemoryModel.Model; accept?: readonly string[]; includeConflicts?: boolean },
) {
  const memory = yield* Memory.Service
  const verdict = yield* memory.decision()
  if (!verdict.on) return yield* Effect.fail(new Error(`Memory is off: ${verdict.reason}. Nothing was imported`))
  const { preview: shown, source, existing, limits, worktree } = yield* planned(options)
  const accept = options.accept ? new Set(options.accept) : undefined
  const chosen = shown.rows
    .map((row, index) => ({ row, candidate: source.candidates[index] }))
    .filter(({ row }) => {
      if (row.status === "rejected" || (row.status === "duplicate" && !row.near)) return false
      if (accept) return accept.has(row.key)
      return row.status === "new" || !!options.includeConflicts
    })
  const limit = limitProblem(
    chosen.map((item) => item.row),
    existing,
    limits,
  )
  if (limit) return yield* Effect.fail(new RefusedError(limit))

  const date = new Date().toISOString()
  const failed: Result["failed"] = []
  // Notes first: the notes sync stores their paragraphs when project memory starts.
  const written: string[] = []
  const noteRows = chosen.filter((item) => item.row.kind === "note")
  for (const note of source.notes) {
    const keep = new Set(noteRows.filter((item) => item.row.note === note.name).map((item) => item.row.text))
    if (!keep.size) continue
    const name = yield* Effect.tryPromise({
      try: () => writeNote(path.join(worktree, ".opencode", "memory"), note.name, noteText(note, keep, date, limits)),
      catch: toError,
    })
    if (name) written.push(name)
  }
  let facts = 0
  for (const { row, candidate } of chosen) {
    if (row.kind !== "fact") continue
    const stored = yield* memory
      .storeImported({
        scope: row.scope,
        text: row.text,
        origin: candidate.origin,
        imported: { from: candidate.from, date },
        parent: options.parent,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) => Effect.sync(() => (failed.push({ text: row.text, reason: error.message }), false))),
      )
    if (stored) facts++
  }
  if (written.length) {
    const skipped = yield* memory.syncNotes(options.parent)
    for (const item of skipped) failed.push({ text: item, reason: "the note paragraph could not be stored" })
  }
  audit(shown, {
    facts,
    notes: written.length,
    noteParagraphs: noteRows.length,
    failed: failed.length,
    scopes: [...new Set(chosen.map((item) => item.row.scope))],
  })
  return { preview: shown, facts, noteParagraphs: noteRows.length, notes: written, failed } satisfies Result
})
