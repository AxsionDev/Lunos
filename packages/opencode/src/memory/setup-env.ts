export * as MemorySetupEnv from "./setup-env"

import { Effect, Option, Schema } from "effect"
import { ConfigMemory } from "@opencode-ai/core/config/memory"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigMemoryBackend } from "@/config/memory-backend"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { MemoryExternal } from "./external"
import { MemoryModel } from "./model"
import { MemoryStore } from "./store"
import { MemoryTemplate } from "./template"

// XCOD-264: what the storage cards say about this machine, from this machine: the real memory
// paths, the model that would extract facts and where its provider processes data, whether Docker
// is there, and which configured providers run on this computer. The TUI asks the server for it;
// `lunos memory setup` computes it in-process, so both show the same words.

const REGION: Record<Jurisdiction.Region, string> = {
  eu: "EU",
  us: "US",
  other: "outside the EU and US",
  configurable: "region set by your deployment",
  unknown: "region unknown",
}

function local(url: unknown) {
  if (typeof url !== "string" || !url) return false
  try {
    return MemoryExternal.loopback(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Providers whose endpoint is on this computer (Ollama, LM Studio), each as its first model. */
export function localModels(providers: readonly Provider.Info[]) {
  const out: string[] = []
  for (const provider of providers) {
    const models = Object.values(provider.models)
    const base = local(provider.options?.baseURL)
    const model = models.find((item) => base || local((item as { api?: { url?: string } }).api?.url))
    if (model) out.push(`${provider.id}/${model.id}`)
  }
  return out
}

/**
 * The organisation's templates and the built-ins it hides, from managed config as written. Read raw,
 * not from the loaded config: loading expands {env:}/{file:} references, so a template's
 * `{env:NEO4J_PASSWORD}` would arrive as the password, be listed by `lunos memory templates --json`
 * and be written into lunos.json when applied. A template with a literal credential is left out.
 */
export async function organisation(): Promise<{ custom: MemoryStorage.Template[]; hide: string[] }> {
  const docs = await ConfigManaged.readManagedDocs().catch(() => [] as unknown[])
  const custom: MemoryStorage.Template[] = []
  const hide = new Set<string>()
  const decode = Schema.decodeUnknownOption(ConfigMemory.Template)
  // In precedence order: the first document that names a template wins.
  for (const doc of docs) {
    const block = (doc as { memory?: { templates?: { custom?: unknown; hide?: unknown } } } | undefined)?.memory
      ?.templates
    for (const name of Array.isArray(block?.hide) ? block.hide : []) if (typeof name === "string") hide.add(name)
    for (const raw of Array.isArray(block?.custom) ? block.custom : []) {
      const item = decode(raw)
      if (Option.isNone(item) || custom.some((entry) => entry.name === item.value.name)) continue
      if (ConfigMemoryBackend.credentialProblems({ memory: item.value.memory }).length) continue
      custom.push(item.value as MemoryStorage.Template)
    }
  }
  return { custom, hide: [...hide] }
}

export const environment = Effect.fn("MemorySetupEnv.environment")(function* (input?: { memory?: ConfigMemory.Info }) {
  const config = yield* Config.Service
  const cfg = yield* config.get()
  const memory = input?.memory ?? cfg.memory
  const ctx = yield* InstanceState.context
  const scopes = memory?.scope ?? ["project"]
  const providers = yield* Provider.Service.use((provider) => provider.list()).pipe(
    Effect.map((list) => Object.values(list)),
    Effect.orElseSucceed(() => [] as Provider.Info[]),
  )
  const locals = localModels(providers)
  const parent = yield* Provider.Service.use((provider) => provider.defaultModel()).pipe(Effect.option)
  const model = (() => {
    if (parent._tag === "None") return undefined
    try {
      const resolved = MemoryModel.resolve({ memory, small_model: cfg.small_model, parent: parent.value }).model
      const id = `${resolved.providerID}/${resolved.modelID}`
      return {
        id,
        region: locals.includes(id) ? "on this computer" : REGION[Jurisdiction.lookup(resolved.providerID).region],
      }
    } catch {
      return undefined
    }
  })()
  const docker = yield* Effect.promise(() => MemoryTemplate.detect())
  const environment: MemoryStorage.Environment = {
    paths: {
      // The project's root, as memory uses it: outside git the worktree is "/", and the directory is meant.
      ...(scopes.includes("project") ? { project: MemoryStore.dir("project", MemoryStore.projectRoot(ctx)) } : {}),
      ...(scopes.includes("user") ? { user: MemoryStore.dir("user", MemoryStore.projectRoot(ctx)) } : {}),
    },
    ...(model ? { model } : {}),
    ...(docker ? { docker } : {}),
    localModels: locals,
  }
  const templates = MemoryStorage.templates(environment, yield* Effect.promise(organisation))
  return { environment, templates }
})
