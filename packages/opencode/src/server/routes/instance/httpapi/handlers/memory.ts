import path from "node:path"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory"
import { MemoryBundle } from "@/memory/bundle"
import { MemoryExport } from "@/memory/export"
import { MemoryImport } from "@/memory/import"
import { MemoryLifecycle } from "@/memory/lifecycle"
import { MemoryStore } from "@/memory/store"
import { Provider } from "@/provider/provider"
import { InstanceHttpApi } from "../api"
import {
  MemoryImportRefusedError,
  MemoryNotFoundError,
  MemoryPassphraseRequiredError,
  MemoryUnavailableError,
} from "../errors"
import type { MemoryExportInput, MemoryImportApplyInput, MemoryImportInput, MemoryOutdateInput } from "../groups/memory"

const SCOPES = ["project", "user"] as const

function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const provider = yield* Provider.Service

    const unavailable = (message: string) => new MemoryUnavailableError({ message })

    /** Engine operations need a model for extraction; the configured default stands in. */
    const parent = Effect.fn("MemoryHttpApi.parent")(function* () {
      const model = yield* provider
        .defaultModel()
        .pipe(Effect.mapError(() => unavailable("No model is configured, and memory needs one to run")))
      return { providerID: model.providerID, modelID: model.modelID }
    })

    const on = Effect.fn("MemoryHttpApi.on")(function* () {
      const verdict = yield* memory.decision()
      if (!verdict.on) return yield* Effect.fail(unavailable(`Memory is off: ${verdict.reason}`))
    })

    const find = Effect.fn("MemoryHttpApi.find")(function* (id: string) {
      for (const scope of SCOPES) {
        const fact = (yield* memory.facts(scope).pipe(Effect.mapError((error) => unavailable(error.message)))).find(
          (item) => item.id === id,
        )
        if (fact) return { scope, fact }
      }
      return yield* Effect.fail(new MemoryNotFoundError({ id, message: `No fact with id ${id}` }))
    })

    const list = Effect.fn("MemoryHttpApi.list")(function* () {
      const verdict = yield* memory.decision()
      const { retention } = yield* memory.policy()
      const at = MemoryLifecycle.now()
      const facts = []
      for (const scope of SCOPES)
        for (const fact of yield* memory.facts(scope).pipe(Effect.mapError((error) => unavailable(error.message)))) {
          const expires = MemoryLifecycle.expiresAt(fact, retention)
          facts.push({
            id: fact.id,
            scope,
            text: fact.text,
            ...fact.provenance,
            ...(fact.imported ? { importedFrom: fact.imported.from } : {}),
            ...(fact.origin ? { originSource: fact.origin.source, originDate: fact.origin.date } : {}),
            state: MemoryLifecycle.state(fact, retention, at),
            ...defined({
              kind: fact.kind,
              validFrom: fact.valid_from,
              invalidAt: fact.invalid_at,
              replacedBy: fact.replaced_by,
              replaces: fact.replaces,
              expires: expires?.toISOString(),
              quarantined: fact.quarantined,
            }),
          })
        }
      return { on: verdict.on, reason: verdict.on ? undefined : verdict.reason, facts }
    })

    const related = Effect.fn("MemoryHttpApi.related")(function* (ctx: { params: { id: string } }) {
      const found = yield* find(ctx.params.id)
      yield* on()
      const results = yield* memory
        .search({ query: found.fact.text, parent: yield* parent(), limit: 5, origin: "tui" })
        .pipe(Effect.mapError((error) => unavailable(error.message)))
      const graph = results.find((result) => result.scope === found.scope)?.graph ?? ""
      return graph.split("\n").filter((line) => line.trim())
    })

    const forget = Effect.fn("MemoryHttpApi.forget")(function* (ctx: { params: { id: string } }) {
      yield* find(ctx.params.id)
      yield* on()
      yield* memory
        .forget({ id: ctx.params.id, parent: yield* parent(), origin: "tui" })
        .pipe(Effect.mapError((error) => unavailable(error.message)))
      return true
    })

    const outdate = Effect.fn("MemoryHttpApi.outdate")(function* (ctx: {
      params: { id: string }
      payload: typeof MemoryOutdateInput.Type
    }) {
      yield* find(ctx.params.id)
      yield* on()
      yield* memory
        .outdate({ id: ctx.params.id, by: ctx.payload.by, parent: yield* parent(), origin: "tui" })
        .pipe(Effect.mapError((error) => unavailable(error.message)))
      return true
    })

    const exportMemory = Effect.fn("MemoryHttpApi.export")(function* (ctx: { payload: typeof MemoryExportInput.Type }) {
      const input = ctx.payload
      const instance = yield* InstanceState.context
      const scopes: MemoryStore.Scope[] =
        input.scope === "project" || input.scope === "user" ? [input.scope] : ["project", "user"]
      if (input.format === "markdown") {
        const dir = path.resolve(
          instance.directory,
          input.out ?? MemoryStore.exportDir(MemoryStore.projectRoot(instance)),
        )
        const facts = yield* MemoryExport.markdown({ dir, scopes }).pipe(
          Effect.mapError((error) => unavailable(error.message)),
        )
        return {
          path: dir,
          format: "markdown" as const,
          facts,
          notes: 0,
          entities: 0,
          relations: 0,
          graph: false,
          encrypted: false,
        }
      }
      const since = input.since === undefined ? undefined : new Date(input.since)
      if (since && Number.isNaN(since.getTime())) return yield* new HttpApiError.BadRequest({})
      if (input.passphrase !== undefined && input.passphrase.length < 8) return yield* new HttpApiError.BadRequest({})
      if (since && input.includeIndex) return yield* new HttpApiError.BadRequest({})
      const encrypt = input.passphrase !== undefined
      // Not the worktree: see MemoryStore.bundles.
      const out =
        input.out ??
        path.join(
          MemoryStore.bundles(),
          MemoryExport.defaultName(new Date(), { zip: (input.zip ?? false) || encrypt, encrypt }),
        )
      const result = yield* MemoryExport.run({
        scopes,
        since,
        graph: input.graph ?? true,
        includeIndex: input.includeIndex ?? false,
        zip: input.zip ?? false,
        passphrase: input.passphrase,
        out,
        directory: instance.directory,
      }).pipe(Effect.mapError((error) => unavailable(error.message)))
      const counts = result.manifest.counts
      return {
        path: result.path,
        format: "bundle" as const,
        facts: counts.facts.total,
        notes: counts.notes,
        entities: counts.entities,
        relations: counts.relations,
        graph: result.manifest.graph.included,
        encrypted: result.encrypted,
        decrypt: result.encrypted ? MemoryBundle.decryptCommand(path.basename(result.path)) : undefined,
      }
    })

    const importError = (error: Error) => {
      if (error instanceof MemoryImport.PassphraseError)
        return new MemoryPassphraseRequiredError({ message: error.message })
      if (
        error instanceof MemoryImport.RefusedError ||
        error.name === "MemoryModelRefused" ||
        error.name === "MemoryImportRefused"
      )
        return new MemoryImportRefusedError({ message: error.message })
      return unavailable(error.message)
    }

    const importOptions = (input: typeof MemoryImportInput.Type) => ({
      path: input.path,
      target: input.scope,
      asFacts: input.asFacts,
      passphrase: async () => input.passphrase,
    })

    const importPreview = Effect.fn("MemoryHttpApi.importPreview")(function* (ctx: {
      payload: typeof MemoryImportInput.Type
    }) {
      const preview = yield* MemoryImport.preview({ ...importOptions(ctx.payload), parent: yield* parent() }).pipe(
        Effect.mapError(importError),
      )
      const source = preview.source
      return {
        kind: source.kind,
        label: source.label,
        sha256: source.sha256,
        format: source.bundle?.format,
        encrypted: source.bundle?.encrypted ?? false,
        warnings: source.warnings,
        rows: preview.rows.map((row) => ({
          key: row.key,
          kind: row.kind,
          scope: row.scope,
          status: row.status,
          reason: row.reason,
          text: row.text,
          file: row.file,
          note: row.note,
          near: row.near,
          otherID: row.other?.id,
          otherText: row.other?.text,
        })),
        counts: preview.counts,
        limit: preview.limit,
        extractionModel: preview.extraction.model,
        extractionCalls: preview.extraction.calls,
        embedding: preview.embedding.model,
        remoteEmbeddingCalls: preview.embedding.remoteCalls,
      }
    })

    const importApply = Effect.fn("MemoryHttpApi.importApply")(function* (ctx: {
      payload: typeof MemoryImportApplyInput.Type
    }) {
      yield* on()
      const result = yield* MemoryImport.run({
        ...importOptions(ctx.payload),
        parent: yield* parent(),
        accept: ctx.payload.accept,
      }).pipe(Effect.mapError(importError))
      return { facts: result.facts, noteParagraphs: result.noteParagraphs, notes: result.notes, failed: result.failed }
    })

    return handlers
      .handle("list", list)
      .handle("importPreview", importPreview)
      .handle("importApply", importApply)
      .handle("related", related)
      .handle("export", exportMemory)
      .handle("outdate", outdate)
      .handle("forget", forget)
  }),
)
