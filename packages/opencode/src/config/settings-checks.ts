import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { ConfigSettings } from "./settings"

/**
 * What `ConfigSettings.set` checks a value against, read from the running instance: the models
 * available here (XCOD-214), the ones residency blocks (XCOD-212) and each model's reasoning
 * variants (XCOD-232), and the agents `default_agent` may name (XCOD-230). The same for /settings
 * and `lunos settings set`.
 */
export const settingsChecks = Effect.fn("ConfigSettings.checks")(function* () {
  const providers = yield* Provider.Service.use((svc) => svc.list())
  const config = yield* Config.Service.use((svc) => svc.get())
  const agents = yield* Agent.Service.use((svc) => svc.list())
  const main = yield* Provider.Service.use((svc) => svc.defaultModel()).pipe(
    Effect.map((model): string | undefined => `${model.providerID}/${model.modelID}`),
    Effect.orElseSucceed(() => undefined),
  )
  const byID = providers as Record<string, { models: Record<string, { variants?: Record<string, unknown> }> }>
  return {
    agents: agents.map((agent) => ({ name: agent.name, mode: agent.mode, hidden: agent.hidden })),
    models: Provider.modelIDs(providers),
    blocked: Provider.blockedModels(providers),
    variants: ConfigSettings.variantLookup({
      config,
      main,
      agents,
      variants: (model) => {
        const slash = model.indexOf("/")
        const info = byID[model.slice(0, slash)]?.models[model.slice(slash + 1)]
        return info ? Object.keys(info.variants ?? {}) : undefined
      },
    }),
  }
})
