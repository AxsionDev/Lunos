import fs from "node:fs/promises"
import os from "node:os"
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
import { MemoryKey } from "@/memory/key"
import { MemoryExport } from "@/memory/export"
import { MemoryImport } from "@/memory/import"
import { MemoryLifecycle } from "@/memory/lifecycle"
import { MemoryNotes } from "@/memory/notes"
import { MemoryRecall } from "@/memory/recall"
import { MemoryStore } from "@/memory/store"

// XCOD-94: the review surface for long-term memory. `list`, `show`, `status`, `verify` and `export`
// read the provenance ledger only, so reviewing memory never starts the engine or needs a model.
// `search`, `forget` and `outdate` start it. Everything works when memory is turned off, except
// those three, which say so.

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

/** The ledger for a scope, or a CLI error saying why it can't be read (a missing key, say). */
const factsOf = (scope: MemoryStore.Scope) =>
  Memory.Service.use((memory) => memory.facts(scope)).pipe(Effect.catch((error) => fail(error.message)))

export const DEFAULT_EXPIRING_DAYS = 7

export const MemoryListCommand = effectCmd({
  command: "list",
  describe: "list remembered facts, with where each came from and their state",
  builder: (yargs) =>
    yargs.option("scope", scopeOption).option("expiring", {
      type: "number",
      describe: `only facts that expire within this many days (default ${DEFAULT_EXPIRING_DAYS}), and expired ones not yet deleted`,
    }),
  handler: Effect.fn("Cli.memory.list")(function* (args) {
    const memory = yield* Memory.Service
    const { retention } = yield* memory.policy()
    const at = MemoryLifecycle.now()
    const lines: string[] = []
    const expiring = process.argv.includes("--expiring") || args.expiring !== undefined
    for (const scope of scopesOf(args.scope)) {
      const facts = yield* factsOf(scope)
      if (expiring) {
        const days =
          args.expiring !== undefined && Number.isFinite(args.expiring) ? args.expiring : DEFAULT_EXPIRING_DAYS
        for (const item of MemoryLifecycle.expiring(facts, retention, days, at)) {
          const state = MemoryLifecycle.state(item.fact, retention, at)
          const when =
            state === "expired"
              ? `expired ${item.expires.toISOString().slice(0, 10)}`
              : `expires ${item.expires.toISOString().slice(0, 10)}`
          lines.push(`${item.fact.id}  ${scope.padEnd(7)}  ${when}  ${oneLine(item.fact.text)}`)
        }
        continue
      }
      for (const fact of facts) {
        const state = MemoryLifecycle.state(fact, retention, at)
        const tag = state === "active" ? "" : `[${state === "purge" ? "expired" : state}] `
        const inferred = fact.kind === "inferred" ? "(inferred) " : ""
        lines.push(
          `${fact.id}  ${scope.padEnd(7)}  ${fact.provenance.date.slice(0, 10)}  ${tag}${inferred}${oneLine(fact.text)}`,
        )
      }
    }
    const empty = expiring ? "No facts are expiring." : "No facts in memory."
    yield* writeStdoutEffect(lines.length ? lines.join(EOL) + EOL : `${empty}${EOL}`)
  }),
})

export const MemoryShowCommand = effectCmd({
  command: "show <id>",
  describe: "show one fact and its provenance",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.show")(function* (args) {
    const memory = yield* Memory.Service
    const { retention } = yield* memory.policy()
    for (const scope of SCOPES) {
      const fact = (yield* factsOf(scope)).find((item) => item.id === args.id)
      if (fact)
        return yield* writeStdoutEffect(
          MemoryExport.markdownFile(scope, fact, MemoryLifecycle.expiresAt(fact, retention)),
        )
    }
    return yield* fail(`No fact with id ${args.id}`)
  }),
})

export const MemorySearchCommand = effectCmd({
  command: "search <query>",
  describe: "search memory the way the agent does",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true })
      .option("history", { type: "boolean", default: false, describe: "also show outdated facts, marked as such" }),
  handler: Effect.fn("Cli.memory.search")(function* (args) {
    const memory = yield* Memory.Service
    const verdict = yield* memory.decision()
    if (!verdict.on) return yield* fail(`Memory is off: ${verdict.reason}`)
    const results = yield* memory
      .search({ query: args.query, parent: yield* parent(), history: args.history, origin: "cli" })
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
      .forget({ id: args.id, parent: yield* parent(), origin: "cli" })
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
    const count = (yield* memory.facts(scope).pipe(Effect.orElseSucceed(() => []))).length
    if (!args.yes)
      return yield* fail(`This deletes ${count} fact(s) in ${scope} memory. Run again with --yes to confirm.`)
    yield* memory.purge(scope).pipe(Effect.catch((error) => fail(error.message)))
    yield* writeStdoutEffect(`Deleted ${scope} memory (${count} fact(s)).${EOL}`)
  }),
})

export const MemoryOutdateCommand = effectCmd({
  command: "outdate <id>",
  describe: "mark a fact as no longer true: kept for history, but no longer recalled",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("by", { type: "string", describe: "the id of the fact that replaces it" }),
  handler: Effect.fn("Cli.memory.outdate")(function* (args) {
    const memory = yield* Memory.Service
    const verdict = yield* memory.decision()
    if (!verdict.on) return yield* fail(`Memory is off: ${verdict.reason}. Turn it on to mark a fact outdated`)
    const result = yield* memory
      .outdate({ id: args.id, by: args.by, parent: yield* parent(), origin: "cli" })
      .pipe(Effect.catch((error) => fail(error.message)))
    const by = result.fact.replaced_by ? `, replaced by ${result.fact.replaced_by}` : ""
    yield* writeStdoutEffect(
      `Marked ${result.fact.id} in ${result.scope} memory outdated as of ${result.fact.invalid_at}${by}. It is kept, and no longer recalled.${EOL}`,
    )
  }),
})

function healthLines(health: Memory.Health[], encryption: MemoryStore.Mode, external = false) {
  const lines: string[] = []
  for (const item of health) {
    if (item.error) {
      lines.push(`${item.scope} memory: can't be read: ${item.error}`)
      continue
    }
    const c = item.counts
    lines.push(
      `${item.scope} memory: ${item.facts} fact(s): ${c.active} active, ${c.outdated} outdated, ${c.expired + c.purge} expired, ${c.quarantined} quarantined`,
    )
    // XCOD-134: in an external database each fact node carries its record's SHA-256; there is no file.
    const ledger = external
      ? "in the external database, one integrity hash per fact"
      : item.facts === 0 && !item.problems.length
        ? "empty"
        : [
            item.unsealed
              ? `not sealed yet (written before integrity checks; sealed when memory next starts)`
              : "sealed",
            item.encrypted
              ? `encrypted (${item.encrypted} line(s))`
              : encryption === "os-keychain"
                ? "not encrypted yet (encrypted when memory next starts)"
                : "not encrypted",
          ].join(", ")
    lines.push(`  ledger: ${ledger}`)
    for (const problem of item.problems)
      lines.push(
        `  QUARANTINED ${problem.id ?? "(unknown id)"} (${external ? "database" : `facts.jsonl line ${problem.line}`}): ${problem.reason}`,
      )
  }
  return lines
}

export const MemoryStatusCommand = effectCmd({
  command: "status",
  describe: "show whether memory is on, how many facts are in each state, and any quarantined facts",
  handler: Effect.fn("Cli.memory.status")(function* () {
    const memory = yield* Memory.Service
    const verdict = yield* memory.decision()
    const { retention, encryption } = yield* memory.policy()
    const where = yield* memory.where()
    const external = where.type !== "embedded"
    // Off means off: with an external database, nothing is opened to count facts (XCOD-134).
    const health = external && !verdict.on ? [] : yield* memory.verify({ origin: "cli" })
    const lines = [
      verdict.on ? "Memory is on." : `Memory is off: ${verdict.reason}.`,
      ...backendLines(where),
      `Retention: ${retention.days ? `${retention.days} day(s), then ${retention.graceDays} day(s) before deletion` : "none (facts don't expire unless they have their own date)"}.`,
      `Encryption: ${encryption === "os-keychain" ? `the ledger is encrypted with a key in the OS keychain (${MemoryKey.describe()}); the engine's database files are not` : "off"}.`,
      ...healthLines(health, encryption, external),
    ]
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})

/** XCOD-134: where memory is kept, whether it can be reached, and each scope's count and last write. */
function backendLines(where: Memory.Where) {
  if (where.type === "embedded")
    return [
      `Backend: embedded (on this machine).`,
      ...where.scopes.map(
        (item) =>
          `  ${item.scope}: ${item.error ? `can't be read: ${item.error}` : `${item.facts} fact(s), last write ${item.lastWrite ?? "never"}`}`,
      ),
    ]
  const tls =
    where.tls === "verified"
      ? "TLS"
      : where.tls === "unverified"
        ? "TLS, certificate not verified"
        : where.tls === "none"
          ? "no TLS"
          : undefined
  const details = [`jurisdiction ${where.jurisdiction ?? "not set"}`, tls, where.readOnly ? "read-only" : undefined]
  return [
    `Backend: ${where.type}${where.host ? ` at ${where.host}` : ""} (${details.filter(Boolean).join(", ")}).`,
    ...where.warnings.map((warning) => `  WARNING: ${warning}.`),
    `  connection: ${where.connection ?? "not opened"}`,
    ...where.scopes.map(
      (item) =>
        `  ${item.scope}: ${item.error ? `can't be read: ${item.error}` : `${item.facts} fact(s), last write ${item.lastWrite ?? "never"}`}`,
    ),
  ]
}

export const MemoryVerifyCommand = effectCmd({
  command: "verify",
  describe: "re-check every ledger entry's integrity hash and the hash chain; quarantined facts are listed",
  builder: (yargs) =>
    yargs
      .option("reseal", {
        type: "boolean",
        default: false,
        describe: "accept the ledger as it is now (after you reviewed it): recompute every hash",
      })
      .option("scope", { ...scopeOption, describe: "with --reseal: which memory" }),
  handler: Effect.fn("Cli.memory.verify")(function* (args) {
    const memory = yield* Memory.Service
    const { encryption } = yield* memory.policy()
    if (args.reseal) {
      if (!args.scope) return yield* fail("--reseal needs --scope project or --scope user")
      const count = yield* memory
        .reseal(args.scope as MemoryStore.Scope)
        .pipe(Effect.catch((error) => fail(error.message)))
      return yield* writeStdoutEffect(
        `Resealed ${args.scope} memory: ${count} quarantined line(s) accepted as they are now.${EOL}`,
      )
    }
    const external = (yield* memory.target()).type !== "embedded"
    const health = yield* memory.verify({ origin: "cli", audit: true })
    yield* writeStdoutEffect(healthLines(health, encryption, external).join(EOL) + EOL)
    const bad = health.filter((item) => item.error || item.problems.length)
    if (bad.length)
      return yield* fail(
        `Integrity check failed. Quarantined facts are not recalled. Forget them with lunos memory forget <id>, or, once you have checked them, accept them with lunos memory verify --reseal --scope <scope>.`,
      )
    yield* writeStdoutEffect(
      external
        ? `Every fact in the database matches its hash.${EOL}`
        : `Every ledger entry matches its hash, and the chain is unbroken.${EOL}`,
    )
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
      const written = yield* MemoryExport.markdown({ dir, scopes: scopesOf(args.scope) }).pipe(
        Effect.catch((error) => fail(error.message)),
      )
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
  const to = preview.destination
  lines.push(
    to
      ? `Destination: ${to.type} database at ${to.host} (jurisdiction ${to.jurisdiction}). Facts are stored as they are: no extraction or embedding calls.`
      : `Graph extraction: up to ${preview.extraction.calls} call(s) to ${preview.extraction.model} (${preview.extraction.source}). Embeddings: ${preview.embedding.model}, ${preview.embedding.remoteCalls} remote call(s).`,
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

/**
 * XCOD-134: move embedded memory into the external database set in memory.backend. Exports a bundle
 * from embedded memory (facts and notes, no graph: the external database keeps facts only), then
 * imports it into the database through the same preview and write guard as `lunos memory import`.
 * Facts keep their ids and provenance. The embedded memory is left as it is.
 */
export const MemoryMigrateCommand = effectCmd({
  command: "migrate",
  describe: "move embedded memory into the external database set in memory.backend; previews first",
  builder: (yargs) =>
    yargs
      .option("to", {
        choices: ["neo4j", "memgraph"] as const,
        demandOption: true,
        describe: "the backend to move to; must match memory.backend.type",
      })
      .option("scope", scopeOption)
      .option("yes", { type: "boolean", default: false, describe: "write the new rows (without it, only preview)" })
      .option("include-conflicts", {
        type: "boolean",
        default: false,
        describe: "with --yes, also write rows marked conflict or near-duplicate",
      }),
  handler: Effect.fn("Cli.memory.migrate")(function* (args) {
    const memory = yield* Memory.Service
    const target = yield* memory.target()
    if (target.type !== args.to)
      return yield* fail(
        `memory.backend.type is "${target.type}", not "${args.to}". Set memory.backend (type, url, jurisdiction and credentials) for the database to move to first`,
      )
    if (target.readOnly) return yield* fail("memory.backend.read_only is set: nothing can be written to it")
    const verdict = yield* memory.decision()
    if (!verdict.on) return yield* fail(`Memory is off: ${verdict.reason}. Nothing was migrated`)
    const scopes = scopesOf(args.scope)
    const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "lunos-migrate-")))
    const bundle = path.join(dir, "bundle")
    const result = yield* Effect.gen(function* () {
      yield* memory.pin("embedded")
      const exported = yield* MemoryExport.run({
        scopes,
        graph: false,
        includeIndex: false,
        zip: false,
        out: bundle,
        directory: dir,
      }).pipe(
        Effect.ensuring(memory.pin(undefined)),
        Effect.catch((error) => fail(`Could not read embedded memory: ${error.message}`)),
      )
      yield* writeStdoutEffect(
        `Read ${exported.manifest.counts.facts.total} fact(s) and ${exported.manifest.counts.notes} note file(s) from embedded memory.${EOL}`,
      )
      const options = { path: bundle, migrate: true, parent: { providerID: "none", modelID: "" } }
      const preview = yield* MemoryImport.preview(options).pipe(Effect.catch((error) => fail(error.message)))
      yield* writeStdoutEffect(previewText(preview) + EOL)
      if (preview.limit) return yield* fail(preview.limit)
      const writable =
        preview.counts.new + (args["include-conflicts"] ? preview.counts.conflict + nearCount(preview) : 0)
      if (!args.yes)
        return yield* writeStdoutEffect(
          `Preview only: nothing was written.${writable ? ` Run again with --yes to migrate ${writable} row(s).` : ""}${EOL}`,
        )
      if (!writable) {
        MemoryImport.audit(preview)
        return yield* writeStdoutEffect(`Nothing new to migrate; nothing was written.${EOL}`)
      }
      return yield* MemoryImport.run({ ...options, includeConflicts: args["include-conflicts"] }).pipe(
        Effect.catch((error) => fail(error.message)),
      )
    }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))))
    if (!result) return
    const lines = [
      `Migrated ${result.facts} fact(s) to ${args.to}. Embedded memory is unchanged; delete it with lunos memory purge once you have checked the database.`,
    ]
    for (const item of result.failed) lines.push(`Not migrated: ${oneLine(item.text, 60)}: ${item.reason}`)
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
    if (result.failed.length) return yield* fail(`${result.failed.length} row(s) could not be migrated`)
  }),
})

function nearCount(preview: MemoryImport.Preview) {
  return preview.rows.filter((row) => row.near).length
}

export const MemoryCommand = cmd({
  command: "memory",
  describe: "review, search, export, import, migrate, outdate, verify and forget long-term memory",
  builder: (yargs) =>
    yargs
      .command(MemoryListCommand)
      .command(MemoryShowCommand)
      .command(MemorySearchCommand)
      .command(MemoryForgetCommand)
      .command(MemoryOutdateCommand)
      .command(MemoryStatusCommand)
      .command(MemoryVerifyCommand)
      .command(MemoryPurgeCommand)
      .command(MemoryExportCommand)
      .command(MemoryImportCommand)
      .command(MemoryMigrateCommand)
      .demandCommand(),
  handler: () => {},
})
