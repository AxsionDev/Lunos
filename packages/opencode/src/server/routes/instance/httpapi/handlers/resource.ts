import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Resource } from "@/resource"
import { InstanceHttpApi } from "../api"
import type { ResourceExcludeInput } from "../groups/resource"

export const resourceHandlers = HttpApiBuilder.group(InstanceHttpApi, "resource", (handlers) =>
  Effect.gen(function* () {
    const resources = yield* Resource.Service

    const list = Effect.fn("ResourceHttpApi.list")(function* (ctx: { query: { sessionID?: string } }) {
      return (yield* resources.list(ctx.query.sessionID)).map((item) => ({
        name: item.name,
        kind: item.kind,
        mode: item.mode,
        scope: item.scope,
        ...(item.description ? { description: item.description } : {}),
        target: item.target,
        readOnly: item.readOnly,
        trusted: item.trusted,
        excluded: item.excluded,
        ...(item.problem ? { problem: item.problem } : {}),
        state: item.state,
        ...(item.status
          ? {
              tokens: item.status.tokens,
              chunks: item.status.chunks,
              indexedAt: item.status.indexedAt,
              ...(item.status.error ? { error: item.status.error } : {}),
            }
          : {}),
      }))
    })

    const exclude = Effect.fn("ResourceHttpApi.exclude")(function* (ctx: {
      payload: typeof ResourceExcludeInput.Type
    }) {
      yield* resources.exclude(ctx.payload.sessionID, ctx.payload.name, ctx.payload.excluded)
      return ctx.payload.excluded
    })

    const context = Effect.fn("ResourceHttpApi.context")(function* (ctx: { query: { sessionID: string } }) {
      return (yield* resources.turn(ctx.query.sessionID)) ?? null
    })

    return handlers.handle("list", list).handle("exclude", exclude).handle("context", context)
  }),
)
