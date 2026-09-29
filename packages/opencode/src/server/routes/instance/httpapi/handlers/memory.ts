import path from "node:path"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory"
import { MemoryBundle } from "@/memory/bundle"
import { MemoryExport } from "@/memory/export"
import { MemoryStore } from "@/memory/store"
import { Provider } from "@/provider/provider"
import { InstanceHttpApi } from "../api"
import { MemoryNotFoundError, MemoryUnavailableError } from "../errors"
import type { MemoryExportInput } from "../groups/memory"

const SCOPES = ["project", "user"] as const

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
        const fact = (yield* memory.facts(scope)).find((item) => item.id === id)
        if (fact) return { scope, fact }
      }
      return yield* Effect.fail(new MemoryNotFoundError({ id, message: `No fact with id ${id}` }))
    })

    const list = Effect.fn("MemoryHttpApi.list")(function* () {
      const verdict = yield* memory.decision()
      const facts = []
      for (const scope of SCOPES)
        for (const fact of yield* memory.facts(scope))
          facts.push({ id: fact.id, scope, text: fact.text, ...fact.provenance })
      return { on: verdict.on, reason: verdict.on ? undefined : verdict.reason, facts }
    })

    const related = Effect.fn("MemoryHttpApi.related")(function* (ctx: { params: { id: string } }) {
      const found = yield* find(ctx.params.id)
      yield* on()
      const results = yield* memory
        .search({ query: found.fact.text, parent: yield* parent(), limit: 5 })
        .pipe(Effect.mapError((error) => unavailable(error.message)))
      const graph = results.find((result) => result.scope === found.scope)?.graph ?? ""
      return graph.split("\n").filter((line) => line.trim())
    })

    const forget = Effect.fn("MemoryHttpApi.forget")(function* (ctx: { params: { id: string } }) {
      yield* find(ctx.params.id)
      yield* on()
      yield* memory
        .forget({ id: ctx.params.id, parent: yield* parent() })
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
        const facts = yield* MemoryExport.markdown({ dir, scopes })
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

    return handlers
      .handle("list", list)
      .handle("related", related)
      .handle("export", exportMemory)
      .handle("forget", forget)
  }),
)
