import fs from "node:fs/promises"
import os from "node:os"
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
import { MemoryStatsLoad } from "@/memory/stats-load"
import { Provider } from "@/provider/provider"
import { InstanceHttpApi } from "../api"
import {
  MemoryImportRefusedError,
  MemoryNotFoundError,
  MemoryPassphraseRequiredError,
  MemoryUnavailableError,
} from "../errors"
import type {
  MemoryExportInput,
  MemoryImportApplyInput,
  MemoryImportInput,
  MemorySetupInput,
  MemorySetupTemplateInput,
} from "../groups/memory"
import { Config } from "@/config/config"
import { AuditLog } from "@/audit/log"
import { MemoryExternal } from "@/memory/external"
import { MemorySetupCheck } from "@/memory/setup-check"
import { MemorySetupEnv } from "@/memory/setup-env"
import { MemoryTemplate } from "@/memory/template"
import { MemoryMove } from "@/memory/move"
import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import type { ConfigMemory } from "@opencode-ai/core/config/memory"

const SCOPES = ["project", "user"] as const

function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service

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
      query: { by?: string }
    }) {
      yield* find(ctx.params.id)
      yield* on()
      yield* memory
        .outdate({ id: ctx.params.id, by: ctx.query.by, parent: yield* parent(), origin: "tui" })
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

    // XCOD-252: analytics, from the ledger and the local audit log only.
    const stats = Effect.fn("MemoryHttpApi.stats")(function* (ctx: {
      query: { scope?: MemoryStore.Scope; days?: number }
    }) {
      return yield* MemoryStatsLoad.load({ scope: ctx.query.scope, days: ctx.query.days })
    })

    // XCOD-249: the wizard's step 2. The same gate as connecting, on the answer instead of the config.
    const setupBackend = Effect.fn("MemoryHttpApi.setupBackend")(function* (ctx: {
      payload: typeof MemorySetupInput.Type
    }) {
      const proposed = ctx.payload.memory as ConfigMemory.Info
      if (MemoryExternal.type(proposed) === "embedded") return { ok: true, warnings: [] }
      const cfg = yield* config.get()
      return yield* Effect.try({
        try: () => ({
          ok: true,
          warnings: MemoryExternal.gate({ memory: proposed, residency: AuditLog.residency(cfg) }).warnings,
        }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ ok: false, warnings: [], error: error instanceof Error ? error.message : String(error) }),
        ),
      )
    })

    // XCOD-249: the wizard's step 6, in a fresh `lunos memory check` that loads the proposed block on
    // top of the config files. This process's own engine for the project is stopped first, so the
    // two never open the same database; it starts again on next use.
    const setupCheck = Effect.fn("MemoryHttpApi.setupCheck")(function* (ctx: {
      payload: typeof MemorySetupInput.Type
    }) {
      const instance = yield* InstanceState.context
      for (const scope of SCOPES) yield* memory.release(scope)
      const env = yield* templateEnv(ctx.payload.template)
      return yield* Effect.promise(() =>
        MemorySetupCheck.run({ directory: instance.directory, memory: ctx.payload.memory, env }),
      )
    })

    // XCOD-264: a template's `.env`, for the `{env:}` references in the block it wrote.
    const templateEnv = Effect.fn("MemoryHttpApi.templateEnv")(function* (
      template: (typeof MemorySetupInput.Type)["template"],
    ) {
      if (!template) return {}
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() =>
        MemoryTemplate.env(MemoryTemplate.dir(template.scope, template.name, instance.worktree)),
      )
    })

    // XCOD-264: "Move my facts": export from the storage in use, import into the proposed one.
    const setupMove = Effect.fn("MemoryHttpApi.setupMove")(function* (ctx: { payload: typeof MemorySetupInput.Type }) {
      const instance = yield* InstanceState.context
      const env = yield* templateEnv(ctx.payload.template)
      const to = MemoryExternal.type(ctx.payload.memory as ConfigMemory.Info)
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "lunos-move-")))
      const bundle = path.join(dir, "bundle")
      return yield* Effect.gen(function* () {
        const exported = yield* MemoryExport.run({
          scopes: yield* memory.scopes(),
          graph: false,
          includeIndex: false,
          zip: false,
          out: bundle,
          directory: dir,
        }).pipe(Effect.result)
        if (exported._tag === "Failure")
          return { ok: false, error: `Could not read the facts to move: ${exported.failure.message}` }
        if (!exported.success.manifest.counts.facts.total) return { ok: true, facts: 0, output: "No facts to move." }
        for (const scope of SCOPES) yield* memory.release(scope)
        return yield* Effect.promise(() =>
          MemoryMove.run({ directory: instance.directory, memory: ctx.payload.memory, to, bundle, env }),
        )
      }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))))
    })

    const setupEnvironment = Effect.fn("MemoryHttpApi.setupEnvironment")(function* () {
      return yield* MemorySetupEnv.environment()
    })

    // XCOD-264: the wizard's "Test connection": the gate, then a probe written, read and deleted.
    const setupTest = Effect.fn("MemoryHttpApi.setupTest")(function* (ctx: { payload: typeof MemorySetupInput.Type }) {
      const cfg = yield* config.get()
      const env = yield* templateEnv(ctx.payload.template)
      const proposed = yield* Effect.promise(() => MemoryTemplate.resolve(ctx.payload.memory, env))
      return yield* Effect.promise(() =>
        MemoryExternal.probe({ memory: proposed as ConfigMemory.Info, residency: AuditLog.residency(cfg) }),
      )
    })

    const templatePlan = Effect.fn("MemoryHttpApi.templatePlan")(function* (
      payload: typeof MemorySetupTemplateInput.Type,
      reveal: boolean,
    ) {
      const instance = yield* InstanceState.context
      const { environment, templates } = yield* MemorySetupEnv.environment()
      const template = MemoryStorage.find(templates, payload.name)
      if (!template) return { error: `No memory template named "${payload.name}"` }
      if (template.unavailable) return { error: `${template.title}: ${template.unavailable}` }
      const plan = yield* Effect.promise(() =>
        MemoryTemplate.plan({
          template,
          scope: payload.scope,
          worktree: instance.worktree,
          values: payload.values,
          docker: environment.docker,
          reveal,
        }),
      )
      return { plan }
    })

    const planResult = (plan: MemoryTemplate.Plan, error?: string) => ({
      ok: !error,
      ...(error ? { error } : {}),
      dir: plan.dir,
      files: plan.files.map((file) => ({
        name: file.name,
        path: file.path,
        content: file.content,
        exists: file.exists,
      })),
      memory: plan.memory,
      command: plan.command,
      ...(plan.template.licence ? { licence: plan.template.licence } : {}),
    })
    const planError = (error: string) => ({ ok: false, error, dir: "", files: [], memory: {}, command: "" })

    const setupTemplatePreview = Effect.fn("MemoryHttpApi.setupTemplatePreview")(function* (ctx: {
      payload: typeof MemorySetupTemplateInput.Type
    }) {
      const got = yield* templatePlan(ctx.payload, false)
      return got.plan ? planResult(got.plan) : planError(got.error!)
    })

    const setupTemplateApply = Effect.fn("MemoryHttpApi.setupTemplateApply")(function* (ctx: {
      payload: typeof MemorySetupTemplateInput.Type
    }) {
      const got = yield* templatePlan(ctx.payload, true)
      if (!got.plan) return planError(got.error!)
      const plan = got.plan
      const written = yield* Effect.tryPromise(() => MemoryTemplate.write(plan, ctx.payload.overwrite ?? [])).pipe(
        Effect.result,
      )
      // Never echo the password back: the result shows the .env masked, like the preview.
      const shown = {
        ...plan,
        files: plan.files.map((file) => (file.name === ".env" ? { ...file, content: "(written, 0600)" } : file)),
      }
      if (written._tag === "Failure") {
        const cause = written.failure.cause
        return planResult(shown, cause instanceof Error ? cause.message : String(cause))
      }
      return planResult(shown)
    })

    const setupTemplateStart = Effect.fn("MemoryHttpApi.setupTemplateStart")(function* (ctx: {
      payload: typeof MemorySetupTemplateInput.Type
    }) {
      const got = yield* templatePlan(ctx.payload, false)
      if (!got.plan) return { ok: false, error: { type: "template", stage: "start", message: got.error! } }
      const plan = got.plan
      const result = yield* Effect.promise(() => MemoryTemplate.start(plan))
      if (result.ok) return { ok: true, ms: result.ms }
      return {
        ok: false,
        error: {
          type: "docker",
          stage: result.stage,
          message: result.message,
          ...(result.fix ? { fix: result.fix } : {}),
        },
      }
    })

    return handlers
      .handle("stats", stats)
      .handle("setupBackend", setupBackend)
      .handle("setupCheck", setupCheck)
      .handle("setupEnvironment", setupEnvironment)
      .handle("setupTest", setupTest)
      .handle("setupMove", setupMove)
      .handle("setupTemplatePreview", setupTemplatePreview)
      .handle("setupTemplateApply", setupTemplateApply)
      .handle("setupTemplateStart", setupTemplateStart)
      .handle("list", list)
      .handle("importPreview", importPreview)
      .handle("importApply", importApply)
      .handle("related", related)
      .handle("export", exportMemory)
      .handle("outdate", outdate)
      .handle("forget", forget)
  }),
)
