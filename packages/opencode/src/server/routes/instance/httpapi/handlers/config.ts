import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { ConfigSettings } from "@/config/settings"
import { Agent } from "@/agent/agent"
import { AgentEditHere } from "@/agent/edit-here"
import fs from "node:fs/promises"
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
      // XCOD-214: model-valued settings are checked against the models available here.
      const providers = yield* providerSvc.list()
      const models = Provider.modelIDs(providers)
      const where = { directory: instance.directory, worktree: instance.worktree }
      const result = yield* Effect.promise(() =>
        (ctx.payload.unset
          ? ConfigSettings.unset({ key: ctx.payload.key, scope: ctx.payload.scope, ctx: where, via: "settings screen" })
          : ConfigSettings.set({
              key: ctx.payload.key,
              value: ctx.payload.value,
              scope: ctx.payload.scope,
              ctx: where,
              via: "settings screen",
              models,
              blocked: Provider.blockedModels(providers),
            })
        ).then(
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

    // XCOD-210: the /agents screen. XCOD-215: also what /settings → Agents shows and edits, including
    // agents turned off with `disable` (they aren't in Agent.list, so they come from config).
    const agents = Effect.fn("ConfigHttpApi.agents")(function* () {
      const instance = yield* InstanceState.context
      const list = yield* Agent.Service.use((svc) => svc.list())
      const cfg = yield* configSvc.get()
      const overrides = yield* Effect.promise(() =>
        ConfigSettings.agentOverrides({ directory: instance.directory, worktree: instance.worktree }),
      )
      const scoped = (name: string) => {
        const user = overrides.user.agent[name]
        const project = overrides.project.agent[name]
        if (!user && !project) return {}
        return { overrides: { ...(user ? { user } : {}), ...(project ? { project } : {}) } }
      }
      const listed = yield* Effect.forEach(list, (agent) =>
        Effect.gen(function* () {
          const file = yield* AgentEditHere.file(agent.name)
          const text = file ? yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined)) : undefined
          return {
            name: agent.name,
            mode: agent.mode,
            ...(agent.description ? { description: agent.description } : {}),
            ...(agent.hidden ? { hidden: true } : {}),
            native: agent.native === true,
            ...(file && text !== undefined ? { file, text } : {}),
            kind:
              agent.mode === "subagent"
                ? ("subagent" as const)
                : agent.native && agent.hidden
                  ? ("helper" as const)
                  : ("main" as const),
            ...(agent.modelSpec ? { model: agent.modelSpec } : {}),
            ...(agent.variant ? { variant: agent.variant } : {}),
            ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
            ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
            ...(agent.topP !== undefined ? { topP: agent.topP } : {}),
            ...(agent.color ? { color: agent.color } : {}),
            ...(agent.prompt ? { prompt: agent.prompt } : {}),
            ...scoped(agent.name),
          }
        }),
      )
      const off = Object.entries(cfg.agent ?? {})
        .filter(([name, value]) => value?.disable && !listed.some((item) => item.name === name))
        .map(([name, value]) => ({
          name,
          mode: value.mode ?? "all",
          ...(value.description ? { description: value.description } : {}),
          native: AgentEditHere.builtIn(name),
          kind:
            value.mode === "subagent"
              ? ("subagent" as const)
              : AgentEditHere.helper(name)
                ? ("helper" as const)
                : ("main" as const),
          disabled: true,
          ...(value.model ? { model: value.model } : {}),
          ...scoped(name),
        }))
      return [...listed, ...off]
    })

    const agentsMigrate = Effect.fn("ConfigHttpApi.agentsMigrate")(function* (ctx: {
      payload: Schema.Schema.Type<typeof ConfigSettings.MigrateInput>
    }) {
      const instance = yield* InstanceState.context
      const result = yield* Effect.promise(() =>
        ConfigSettings.migrateAgents({
          scope: ctx.payload.scope,
          ctx: { directory: instance.directory, worktree: instance.worktree },
          via: "settings screen",
        }).then(
          (ok) => ({ ok: true as const, ...ok }),
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        ),
      )
      if (result.ok && result.migrated.length) {
        yield* configSvc.invalidate()
        yield* markInstanceForDisposal(instance)
      }
      return result
    })

    const agentSave = Effect.fn("ConfigHttpApi.agentSave")(function* (ctx: {
      payload: Schema.Schema.Type<typeof AgentEditHere.SaveInput>
    }) {
      const file = yield* AgentEditHere.file(ctx.payload.name)
      if (!file) return { ok: false as const, problems: [`"${ctx.payload.name}" has no agent file Lunos can edit`] }
      const saved = yield* AgentEditHere.saveText(file, ctx.payload.text)
      if (saved.ok) {
        // Agents load with the config; reload it so the change applies to new sessions.
        yield* configSvc.invalidate()
        yield* markInstanceForDisposal(yield* InstanceState.context)
      }
      return saved
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
      .handle("agents", agents)
      .handle("agentSave", agentSave)
      .handle("agentsMigrate", agentsMigrate)
      .handle("providers", providers)
  }),
)
