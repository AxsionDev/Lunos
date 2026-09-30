import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { ConfigSettings } from "@/config/settings"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { gte } from "drizzle-orm"
import type { Schema } from "effect"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const { db } = yield* Database.Service
    const USAGE_DAYS = 30

    // XCOD-128: the /settings screen.
    const settings = Effect.fn("ConfigHttpApi.settings")(function* () {
      const ctx = yield* InstanceState.context
      const config = yield* configSvc.get()
      const origins = yield* configSvc.origins()
      const scope = { directory: ctx.directory, worktree: ctx.worktree }
      const cutoff = Date.now() - USAGE_DAYS * 24 * 60 * 60 * 1000
      const sessions = yield* db
        .select({
          cost: SessionTable.cost,
          tokens_input: SessionTable.tokens_input,
          tokens_output: SessionTable.tokens_output,
          tokens_reasoning: SessionTable.tokens_reasoning,
          tokens_cache_read: SessionTable.tokens_cache_read,
          tokens_cache_write: SessionTable.tokens_cache_write,
        })
        .from(SessionTable)
        .where(gte(SessionTable.time_updated, cutoff))
        .all()
        .pipe(Effect.orDie)
      return yield* Effect.promise(async () => {
        const locked = await ConfigSettings.lockedKeys()
        return {
          rows: await ConfigSettings.list({ config, origins, locked, ctx: scope }),
          layers: await ConfigSettings.layers(scope),
          locked,
          files: {
            user: {
              config: ConfigSettings.targetFile("config", "user", scope),
              tui: ConfigSettings.targetFile("tui", "user", scope),
            },
            project: {
              config: ConfigSettings.targetFile("config", "project", scope),
              tui: ConfigSettings.targetFile("tui", "project", scope),
            },
          },
          usage: ConfigSettings.usage(sessions, USAGE_DAYS),
          sandbox: await import("@/sandbox")
            .then(({ Sandbox }) => Sandbox.status(scope?.worktree))
            .catch(() => undefined),
        } as Schema.Schema.Type<typeof ConfigSettings.SnapshotSchema>
      })
    })

    const settingsSet = Effect.fn("ConfigHttpApi.settingsSet")(function* (ctx: {
      payload: Schema.Schema.Type<typeof ConfigSettings.SetInput>
    }) {
      const instance = yield* InstanceState.context
      const result = yield* Effect.promise(() =>
        ConfigSettings.set({
          key: ctx.payload.key,
          value: ctx.payload.value,
          scope: ctx.payload.scope,
          ctx: { directory: instance.directory, worktree: instance.worktree },
          via: "settings screen",
        }).then(
          (ok) => ({ ok: true as const, ...ok, value: ok.value as Schema.Json }),
          (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof ConfigSettings.SettingError ? error.code : "error",
          }),
        ),
      )
      // Config keys reload with the instance; tui.json is applied by the TUI itself.
      if (result.ok && result.changed && !result.key.startsWith("tui.")) {
        yield* configSvc.invalidate()
        yield* markInstanceForDisposal(instance)
      }
      return result
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("settings", settings)
      .handle("settingsSet", settingsSet)
      .handle("providers", providers)
  }),
)
