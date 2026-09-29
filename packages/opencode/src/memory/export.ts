export * as MemoryExport from "./export"

import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { AuditLog } from "@/audit/log"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "."
import { MemoryBundle } from "./bundle"
import { MemorySidecar } from "./sidecar"
import { MemoryStore } from "./store"

/**
 * `lunos memory export` in bundle form (XCOD-132), shared by the CLI and the TUI's Export action so
 * both take the same options. Reads the ledger and the notes without the engine; reads the graph
 * through the sidecar (see `Memory.graph`). Everything is gathered and checked for secrets before
 * a byte is written.
 */

export interface Options {
  scopes: MemoryStore.Scope[]
  since?: Date
  /** Include the graph. Needs memory on, since reading it starts the engine. */
  graph: boolean
  /** Copy the engine's database files, for a same-version, same-engine restore. */
  includeIndex: boolean
  zip: boolean
  /** Encrypt with this passphrase. Implies zip. Never stored. */
  passphrase?: string
  /** Where to write. Default: `lunos-memory-<time>[.zip|.zip.enc]` in `directory`. */
  out?: string
  directory: string
}

export class GraphUnavailableError extends Error {
  override name = "MemoryGraphUnavailable"
}

/**
 * The engine's files hold every fact's text in the scope, so they can't honour `--since`, and the
 * secret check (which reads the ledger) would not have seen facts the filter left out.
 */
export const SINCE_WITH_INDEX = "--since can't be combined with --include-index: the engine's files hold every fact"

export function defaultName(now: Date, input: { zip: boolean; encrypt: boolean }) {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-")
  return `lunos-memory-${stamp}${input.encrypt ? ".zip.enc" : input.zip ? ".zip" : ""}`
}

/** Hand-written notes, `.opencode/memory/*.md`: the files the notes sync reads. */
async function notes(worktree: string) {
  const dir = path.join(worktree, ".opencode", "memory")
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: { name: string; text: string }[] = []
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .toSorted((a, b) => a.name.localeCompare(b.name)))
    out.push({ name: entry.name, text: await fs.readFile(path.join(dir, entry.name), "utf8") })
  return out
}

/** The engine's files for a scope, minus its logs and the ledger (the bundle's facts.jsonl is the ledger). */
async function indexFiles(scope: MemoryStore.Scope, root: string) {
  const files: { path: string; source: string }[] = []
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    const relative = path.relative(root, file).split(path.sep).join("/")
    if (relative === "facts.jsonl" || relative === ".gitignore" || relative.startsWith("logs/")) continue
    files.push({ path: `index/${scope}/${relative}`, source: file })
  }
  return files.toSorted((a, b) => a.path.localeCompare(b.path))
}

/** One fact as Markdown with its provenance: XCOD-94's `--format markdown` and `lunos memory show`. */
export function markdownFile(scope: MemoryStore.Scope, fact: MemoryStore.Fact) {
  const p = fact.provenance
  return [
    "---",
    `id: ${fact.id}`,
    `scope: ${scope}`,
    `date: ${p.date}`,
    `source: ${JSON.stringify(p.source)}`,
    `session: ${p.sessionID}`,
    `agent: ${p.agent}`,
    "---",
    "",
    fact.text,
    "",
  ].join("\n")
}

/** `--format markdown`: one `<scope>/<id>.md` per fact, for review in git. Returns how many. */
export const markdown = Effect.fn("MemoryExport.markdown")(function* (input: {
  dir: string
  scopes: MemoryStore.Scope[]
}) {
  const memory = yield* Memory.Service
  let written = 0
  for (const scope of input.scopes) {
    const facts = yield* memory.facts(scope)
    if (!facts.length) continue
    const target = path.join(input.dir, scope)
    yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))
    for (const fact of facts) {
      yield* Effect.promise(() => fs.writeFile(path.join(target, `${fact.id}.md`), markdownFile(scope, fact)))
      written++
    }
  }
  return written
})

export const run = Effect.fn("MemoryExport.run")(function* (options: Options) {
  if (options.since && options.includeIndex) return yield* Effect.fail(new Error(SINCE_WITH_INDEX))
  const memory = yield* Memory.Service
  const ctx = yield* InstanceState.context
  const worktree = MemoryStore.projectRoot(ctx)
  const created = new Date()
  const encrypt = options.passphrase !== undefined
  const zip = options.zip || encrypt
  const out = path.resolve(options.directory, options.out ?? defaultName(created, { zip, encrypt }))

  const facts: MemoryBundle.Fact[] = []
  const known = new Map<MemoryStore.Scope, Set<string>>()
  for (const scope of options.scopes) {
    const kept = (yield* memory.facts(scope)).filter(
      (item) => !options.since || new Date(item.provenance.date).getTime() >= options.since.getTime(),
    )
    known.set(scope, new Set(kept.map((item) => item.id)))
    facts.push(...kept.map((item) => MemoryBundle.fact(scope, item)))
  }

  const graph: MemoryBundle.Graph = { entities: [], relations: [] }
  let graphOmitted: string | undefined
  if (!options.graph) graphOmitted = "left out with --no-graph"
  else
    for (const scope of options.scopes) {
      // An empty scope has no graph; don't start an engine to learn that.
      if (!(yield* memory.facts(scope)).length) continue
      const raw = yield* memory
        .graph(scope)
        .pipe(
          Effect.mapError(
            (error) =>
              new GraphUnavailableError(
                `Could not read the ${scope} memory graph: ${error.message}\nExport without it with --no-graph: the facts are the source of truth, and the graph is rebuilt from them on import.`,
              ),
          ),
        )
      const part = MemoryBundle.graph(scope, raw, known.get(scope)!)
      graph.entities.push(...part.entities)
      graph.relations.push(...part.relations)
    }

  const noteFiles = options.scopes.includes("project") ? yield* Effect.promise(() => notes(worktree)) : []

  const found = MemoryBundle.secrets({ facts, graph, notes: noteFiles })
  if (found.length) return yield* Effect.fail(new MemoryBundle.SecretsError(found))

  let index: MemoryBundle.Content["index"]
  if (options.includeIndex) {
    const files: { path: string; source: string }[] = []
    const scopes: MemoryStore.Scope[] = []
    for (const scope of options.scopes) {
      // The engine holds its database files open; stop it so the copy is consistent.
      yield* memory.release(scope)
      const found = yield* Effect.promise(() => indexFiles(scope, MemoryStore.dir(scope, worktree)))
      if (!found.length) continue
      scopes.push(scope)
      files.push(...found)
    }
    index = {
      scopes,
      files,
      engineVersion: MemorySidecar.ENGINE.version,
      embedding: MemorySidecar.ENGINE.embedding,
    }
  }

  const bundle = yield* Effect.promise(() =>
    MemoryBundle.entries({
      version: InstallationVersion,
      created,
      scopes: options.scopes,
      since: options.since,
      facts,
      graph,
      graphOmitted,
      notes: noteFiles,
      index,
    }),
  )
  yield* Effect.tryPromise({
    try: () => MemoryBundle.write({ entries: bundle.entries, out, zip, passphrase: options.passphrase }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
  AuditLog.emit("memory.export", {
    scopes: options.scopes,
    facts: facts.length,
    format: MemoryBundle.FORMAT,
    zip,
    encrypted: encrypt,
    index: options.includeIndex,
    graph: !graphOmitted,
  })
  return { path: out, manifest: bundle.manifest, encrypted: encrypt }
})
