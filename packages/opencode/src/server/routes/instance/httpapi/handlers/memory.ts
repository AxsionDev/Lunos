import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Memory } from "@/memory"
import { Provider } from "@/provider/provider"
import { InstanceHttpApi } from "../api"
import { MemoryNotFoundError, MemoryUnavailableError } from "../errors"

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

    return handlers.handle("list", list).handle("related", related).handle("forget", forget)
  }),
)
