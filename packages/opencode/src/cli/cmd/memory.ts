import fs from "node:fs/promises"
import path from "node:path"
import { EOL } from "os"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory"
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

function markdown(scope: MemoryStore.Scope, fact: MemoryStore.Fact) {
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
      if (fact) return yield* writeStdoutEffect(markdown(scope, fact))
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

export const MemoryExportCommand = effectCmd({
  command: "export",
  describe:
    "write every fact as a Markdown file with its provenance, for review in git (forget removes a fact's file from the default directory)",
  builder: (yargs) =>
    yargs.option("scope", scopeOption).option("dir", {
      type: "string",
      describe: "where to write them (default: .opencode/memory/export)",
    }),
  handler: Effect.fn("Cli.memory.export")(function* (args) {
    const memory = yield* Memory.Service
    const ctx = yield* InstanceState.context
    const dir = path.resolve(ctx.directory, args.dir ?? MemoryStore.exportDir(MemoryStore.projectRoot(ctx)))
    let written = 0
    for (const scope of scopesOf(args.scope)) {
      const facts = yield* memory.facts(scope)
      if (!facts.length) continue
      const target = path.join(dir, scope)
      yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))
      for (const fact of facts) {
        yield* Effect.promise(() => fs.writeFile(path.join(target, `${fact.id}.md`), markdown(scope, fact)))
        written++
      }
    }
    yield* writeStdoutEffect(
      written ? `Wrote ${written} fact(s) to ${dir}${EOL}` : `No facts in memory; nothing written.${EOL}`,
    )
  }),
})

export const MemoryCommand = cmd({
  command: "memory",
  describe: "review, search, export and forget long-term memory",
  builder: (yargs) =>
    yargs
      .command(MemoryListCommand)
      .command(MemoryShowCommand)
      .command(MemorySearchCommand)
      .command(MemoryForgetCommand)
      .command(MemoryPurgeCommand)
      .command(MemoryExportCommand)
      .demandCommand(),
  handler: () => {},
})
