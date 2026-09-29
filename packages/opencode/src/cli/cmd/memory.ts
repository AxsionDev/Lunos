import path from "node:path"
import { EOL } from "os"
import { Effect, Option } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import * as Prompt from "../effect/prompt"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory"
import { MemoryBundle } from "@/memory/bundle"
import { MemoryExport } from "@/memory/export"
import { MemoryImport } from "@/memory/import"
import { MemoryNotes } from "@/memory/notes"
import { MemoryRecall } from "@/memory/recall"
import { MemoryStore } from "@/memory/store"

// XCOD-94: the review surface for long-term memory. `list`, `show` and `export` read the provenance
// ledger only, so reviewing memory never starts the engine or needs a model. `search` and `forget`
// start it. Everything works when memory is turned off, except `search` and `forget`, which say so.

const SCOPES = ["project", "user"] as const

const scopeOption = {
  choices: SCOPES,
  describe: "only this memory (default: both)",
} as const

function scopesOf(value: unknown): MemoryStore.Scope[] {
  return value === "project" || value === "user" ? [value] : [...SCOPES]
}

/** Engine operations need a model for extraction; the configured default stands in for the main one. */
const parent = Effect.fn("Cli.memory.parent")(function* () {
  const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
  const model = yield* Provider.Service.use((provider) => provider.defaultModel()).pipe(
    Effect.catch(() => fail("No model is configured, and memory needs one to run")),
  )
  return { providerID: model.providerID, modelID: model.modelID }
})

function oneLine(text: string, max = 100) {
  const flat = text.replace(/\s+/g, " ")
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

export const MemoryListCommand = effectCmd({
  command: "list",
  describe: "list remembered facts, with where each came from",
  builder: (yargs) => yargs.option("scope", scopeOption),
  handler: Effect.fn("Cli.memory.list")(function* (args) {
    const memory = yield* Memory.Service
    const lines: string[] = []
    for (const scope of scopesOf(args.scope))
      for (const fact of yield* memory.facts(scope))
        lines.push(`${fact.id}  ${scope.padEnd(7)}  ${fact.provenance.date.slice(0, 10)}  ${oneLine(fact.text)}`)
    yield* writeStdoutEffect(lines.length ? lines.join(EOL) + EOL : `No facts in memory.${EOL}`)
  }),
})

export const MemoryShowCommand = effectCmd({
  command: "show <id>",
  describe: "show one fact and its provenance",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.show")(function* (args) {
    const memory = yield* Memory.Service
    for (const scope of SCOPES) {
      const fact = (yield* memory.facts(scope)).find((item) => item.id === args.id)
      if (fact) return yield* writeStdoutEffect(MemoryExport.markdownFile(scope, fact))
    }
    return yield* fail(`No fact with id ${args.id}`)
  }),
})

export const MemorySearchCommand = effectCmd({
  command: "search <query>",
  describe: "search memory the way the agent does",
  builder: (yargs) => yargs.positional("query", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.search")(function* (args) {
    const memory = yield* Memory.Service
    const verdict = yield* memory.decision()
    if (!verdict.on) return yield* fail(`Memory is off: ${verdict.reason}`)
    const results = yield* memory
      .search({ query: args.query, parent: yield* parent() })
      .pipe(Effect.catch((error) => fail(error.message)))
    yield* writeStdoutEffect((MemoryRecall.block(results) ?? "Nothing in memory matches.") + EOL)
  }),
})

export const MemoryForgetCommand = effectCmd({
  command: "forget <id>",
  describe: "remove one fact from memory",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.forget")(function* (args) {
    const memory = yield* Memory.Service
    const verdict = yield* memory.decision()
    if (!verdict.on) return yield* fail(`Memory is off: ${verdict.reason}. Turn it on to forget a fact, or use purge`)
    const removed = yield* memory
      .forget({ id: args.id, parent: yield* parent() })
      .pipe(Effect.catch((error) => fail(error.message)))
    if (!removed) return yield* fail(`No fact with id ${args.id}`)
    const note =
      removed.fact.provenance.sessionID === MemoryNotes.SESSION
        ? ` It came from ${removed.fact.provenance.source}: edit or delete it there, or it returns next time memory starts.`
        : ""
    yield* writeStdoutEffect(`Forgot ${removed.fact.id} from ${removed.scope} memory.${note}${EOL}`)
  }),
})

export const MemoryPurgeCommand = effectCmd({
  command: "purge",
  describe: "delete all of a memory's stored facts and graph (hand-written notes are kept)",
  builder: (yargs) =>
    yargs
      .option("scope", { ...scopeOption, demandOption: true, describe: "which memory to delete" })
      .option("yes", { type: "boolean", default: false, describe: "confirm" }),
  handler: Effect.fn("Cli.memory.purge")(function* (args) {
    const memory = yield* Memory.Service
    const scope = args.scope as MemoryStore.Scope
    const count = (yield* memory.facts(scope)).length
    if (!args.yes)
      return yield* fail(`This deletes ${count} fact(s) in ${scope} memory. Run again with --yes to confirm.`)
    yield* memory.purge(scope).pipe(Effect.catch((error) => fail(error.message)))
    yield* writeStdoutEffect(`Deleted ${scope} memory (${count} fact(s)).${EOL}`)
  }),
})

/** Where the passphrase for `--encrypt` comes from when there is no terminal to ask on. */
export const PASSPHRASE_ENV = "LUNOS_MEMORY_PASSPHRASE"

const passphrase = Effect.fn("Cli.memory.passphrase")(function* () {
  const fromEnv = process.env[PASSPHRASE_ENV]
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY)
    return yield* fail(`--encrypt needs a passphrase: run it in a terminal, or set ${PASSPHRASE_ENV}`)
  const first = yield* Prompt.password({
    message: "Passphrase for the export (it is not stored anywhere)",
    validate: (value) => (value && value.length >= 8 ? undefined : "At least 8 characters"),
  })
  if (Option.isNone(first)) return yield* fail("Cancelled; nothing was exported")
  const again = yield* Prompt.password({ message: "The same passphrase again" })
  if (Option.isNone(again)) return yield* fail("Cancelled; nothing was exported")
  if (again.value !== first.value) return yield* fail("The passphrases don't match; nothing was exported")
  return first.value
})

export function parseSince(value: unknown) {
  if (value === undefined) return undefined
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

export const MemoryExportCommand = effectCmd({
  command: "export",
  describe:
    "export all memory as a versioned bundle (facts, graph, notes, provenance), or as one Markdown file per fact with --format markdown",
  builder: (yargs) =>
    yargs
      .option("format", {
        choices: ["bundle", "markdown"] as const,
        default: "bundle" as const,
        describe: "bundle: everything, machine-readable (lunos-memory/1). markdown: one file per fact, for git review",
      })
      .option("scope", {
        choices: [...SCOPES, "both"] as const,
        default: "both" as const,
        describe: "which memory to export",
      })
      .option("since", { type: "string", describe: "bundle: only facts saved on or after this date (ISO 8601)" })
      .option("out", {
        type: "string",
        describe: "bundle: where to write it (default: ./lunos-memory-<time>, plus .zip or .zip.enc)",
      })
      .option("zip", {
        type: "boolean",
        default: false,
        describe: "bundle: write one .zip file instead of a directory",
      })
      .option("encrypt", {
        type: "boolean",
        default: false,
        describe: `bundle: encrypt the .zip with a passphrase (asked for, or ${PASSPHRASE_ENV}); never stored`,
      })
      .option("graph", {
        type: "boolean",
        default: true,
        describe: "bundle: include the entity graph (reading it starts memory; --no-graph exports without)",
      })
      .option("include-index", {
        type: "boolean",
        default: false,
        describe: "bundle: also copy the engine's database files, for a same-version, same-engine restore",
      })
      .option("dir", {
        type: "string",
        describe: "markdown: where to write the files (default: .opencode/memory/export)",
      }),
  handler: Effect.fn("Cli.memory.export")(function* (args) {
    const ctx = yield* InstanceState.context
    if (args.format === "markdown") {
      const dir = path.resolve(ctx.directory, args.dir ?? MemoryStore.exportDir(MemoryStore.projectRoot(ctx)))
      const written = yield* MemoryExport.markdown({ dir, scopes: scopesOf(args.scope) })
      return yield* writeStdoutEffect(
        written ? `Wrote ${written} fact(s) to ${dir}${EOL}` : `No facts in memory; nothing written.${EOL}`,
      )
    }
    if (args.dir !== undefined)
      return yield* fail("--dir is for --format markdown. For a bundle, use --out <path> to choose where it goes")
    const since = parseSince(args.since)
    if (since === null) return yield* fail(`--since must be a date, such as 2026-09-01; got "${args.since}"`)
    const result = yield* MemoryExport.run({
      scopes: scopesOf(args.scope),
      since,
      graph: args.graph,
      includeIndex: args["include-index"],
      zip: args.zip,
      passphrase: args.encrypt ? yield* passphrase() : undefined,
      out: args.out,
      directory: ctx.directory,
    }).pipe(Effect.catch((error) => fail(error.message)))
    const counts = result.manifest.counts
    const lines = [
      `Exported ${counts.facts.total} fact(s) (${counts.facts.project} project, ${counts.facts.user} user), ${counts.notes} note file(s), ${counts.entities} entities and ${counts.relations} relationships to ${result.path}`,
    ]
    if (!result.manifest.graph.included) lines.push(`The graph was not included: ${result.manifest.graph.reason}.`)
    if (result.encrypted) lines.push(`Decrypt with: ${MemoryBundle.decryptCommand(path.basename(result.path))}`)
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})

const importPassphrase = Effect.fn("Cli.memory.importPassphrase")(function* () {
  const fromEnv = process.env[PASSPHRASE_ENV]
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY) return undefined
  const value = yield* Prompt.password({ message: "Passphrase for the encrypted bundle" })
  return Option.isNone(value) ? undefined : value.value
})

const STATUS_ORDER: MemoryImport.Status[] = ["new", "conflict", "duplicate", "rejected"]

/** The preview table: one row per fact or note paragraph, grouped by status, each with its reason. */
export function previewText(preview: MemoryImport.Preview) {
  const source = preview.source
  const what =
    source.kind === "bundle"
      ? `bundle ${source.bundle?.format}${source.bundle?.encrypted ? ", encrypted" : ""}, created ${source.bundle?.created}`
      : "Markdown"
  const lines = [`Import from ${source.label} (${what}, sha256 ${source.sha256.slice(0, 12)}…)`]
  for (const warning of source.warnings) lines.push(`  ${warning}.`)
  lines.push("")
  if (!preview.rows.length) lines.push("Nothing to import.")
  else {
    lines.push(`${"STATUS".padEnd(10)} ${"SCOPE".padEnd(7)} ${"KIND".padEnd(4)}  ${"TEXT".padEnd(60)}  REASON`)
    for (const status of STATUS_ORDER)
      for (const row of preview.rows.filter((item) => item.status === status)) {
        lines.push(
          `${row.status.padEnd(10)} ${row.scope.padEnd(7)} ${row.kind.padEnd(4)}  ${oneLine(row.text, 60).padEnd(60)}  ${row.reason} [${row.file}${row.note ? ` → ${row.note}` : ""}]`,
        )
        if (row.other && row.status === "conflict") lines.push(`${"".padEnd(25)}  vs ${oneLine(row.other.text, 60)}`)
      }
  }
  const c = preview.counts
  lines.push("", `${c.new} new, ${c.duplicate} duplicate, ${c.conflict} conflict, ${c.rejected} rejected`)
  lines.push(
    `Graph extraction: up to ${preview.extraction.calls} call(s) to ${preview.extraction.model} (${preview.extraction.source}). Embeddings: ${preview.embedding.model}, ${preview.embedding.remoteCalls} remote call(s).`,
  )
  return lines.join(EOL)
}

export const MemoryImportCommand = effectCmd({
  command: "import <path>",
  describe:
    "import memory from a Lunos bundle, Markdown, or AGENTS.md / CLAUDE.md / Claude Code memory notes; previews first",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        demandOption: true,
        describe: "a bundle folder, .zip or .zip.enc, a Markdown file or folder, or another agent's memory file",
      })
      .option("scope", {
        choices: SCOPES,
        describe: "put everything in this memory (default: a bundle fact's own scope; project for Markdown)",
      })
      .option("yes", { type: "boolean", default: false, describe: "write the new rows (without it, only preview)" })
      .option("dry-run", { type: "boolean", default: false, describe: "only preview, even with --yes" })
      .option("as-facts", {
        type: "boolean",
        default: false,
        describe: "import AGENTS.md, CLAUDE.md, Claude Code memory and bundle notes as facts instead of notes",
      })
      .option("include-conflicts", {
        type: "boolean",
        default: false,
        describe: "with --yes, also write rows marked conflict or near-duplicate",
      }),
  handler: Effect.fn("Cli.memory.import")(function* (args) {
    const options = {
      path: args.path,
      target: args.scope as MemoryStore.Scope | undefined,
      asFacts: args["as-facts"],
      parent: yield* parent(),
    }
    // Asked for at most once: the preview's read and the import's re-read use the same answer.
    let asked: Promise<string | undefined> | undefined
    const passphrase = () =>
      (asked ??= Effect.runPromise(importPassphrase().pipe(Effect.orElseSucceed(() => undefined))))
    const preview = yield* MemoryImport.preview({ ...options, passphrase }).pipe(
      Effect.catch((error) => fail(error.message)),
    )
    yield* writeStdoutEffect(previewText(preview) + EOL)
    if (preview.limit) return yield* fail(preview.limit)
    const writable = preview.counts.new + (args["include-conflicts"] ? preview.counts.conflict + nearCount(preview) : 0)
    if (args["dry-run"] || !args.yes) {
      const why = args["dry-run"] ? "Dry run: nothing was written." : "Preview only: nothing was written."
      const next = writable && !args["dry-run"] ? ` Run again with --yes to import ${writable} row(s).` : ""
      return yield* writeStdoutEffect(why + next + EOL)
    }
    if (!writable) {
      MemoryImport.audit(preview)
      return yield* writeStdoutEffect(`Nothing new to import; nothing was written.${EOL}`)
    }
    const result = yield* MemoryImport.run({
      ...options,
      passphrase,
      includeConflicts: args["include-conflicts"],
    }).pipe(Effect.catch((error) => fail(error.message)))
    const lines = [
      `Imported ${result.facts} fact(s)${result.noteParagraphs ? ` and ${result.noteParagraphs} note paragraph(s)` : ""}${result.notes.length ? ` (notes written: ${result.notes.map((name) => `.opencode/memory/${name}`).join(", ")})` : ""}.`,
    ]
    for (const item of result.failed) lines.push(`Not imported: ${oneLine(item.text, 60)}: ${item.reason}`)
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
    if (result.failed.length) return yield* fail(`${result.failed.length} row(s) could not be imported`)
  }),
})

function nearCount(preview: MemoryImport.Preview) {
  return preview.rows.filter((row) => row.near).length
}

export const MemoryCommand = cmd({
  command: "memory",
  describe: "review, search, export, import and forget long-term memory",
  builder: (yargs) =>
    yargs
      .command(MemoryListCommand)
      .command(MemoryShowCommand)
      .command(MemorySearchCommand)
      .command(MemoryForgetCommand)
      .command(MemoryPurgeCommand)
      .command(MemoryExportCommand)
      .command(MemoryImportCommand)
      .demandCommand(),
  handler: () => {},
})
