import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLMEvent } from "@opencode-ai/llm"
import { Context, Effect, Layer, Stream } from "effect"
import type { Agent } from "@/agent/agent"
import { AuditLog } from "@/audit/log"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { MemoryBackend } from "./backend"
import { MemoryModel } from "./model"
import { MemorySidecar } from "./sidecar"
import { MemoryStore } from "./store"
import { MemorySwitch } from "./switch"

/**
 * Long-term memory (XCOD-94). Nothing starts until memory is on (`MemorySwitch`) and something
 * asks for a backend: then the memory model is resolved and checked against the residency policy,
 * and only if that passes is the sidecar started for the requested scope. One sidecar per scope
 * per instance, stopped with the instance.
 */

const MEMORY_AGENT: Agent.Info = {
  name: "memory",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

export class OffError extends Error {
  override name = "MemoryOff"
}

export interface Interface {
  readonly decision: (sessionID?: string) => Effect.Effect<MemorySwitch.Decision>
  readonly setSessionOff: (sessionID: string, off: boolean) => Effect.Effect<void>
  /** Scopes memory uses, from `memory.scope` (default ["project"]). */
  readonly scopes: () => Effect.Effect<MemoryStore.Scope[]>
  /** The running backend for a scope, starting it if needed. Fails when memory is off. */
  readonly backend: (input: {
    scope: MemoryStore.Scope
    sessionID?: string
    parent: MemoryModel.Model
  }) => Effect.Effect<MemoryBackend.Backend, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

interface State {
  sessionOff: Set<string>
  running: Map<MemoryStore.Scope, Promise<MemoryBackend.Backend>>
  worktree: string
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Memory.state")(function* (ctx) {
        const state: State = { sessionOff: new Set(), running: new Map(), worktree: ctx.worktree }
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            const running = [...state.running.values()]
            state.running.clear()
            await Promise.all(running.map((item) => item.then((backend) => backend.close()).catch(() => {})))
          }),
        )
        return state
      }),
    )

    const decision = Effect.fn("Memory.decision")(function* (sessionID?: string) {
      const cfg = yield* config.get()
      const s = yield* InstanceState.get(state)
      return MemorySwitch.decide({
        config: cfg.memory,
        env: process.env,
        sessionOff: sessionID !== undefined && s.sessionOff.has(sessionID),
      })
    })

    const setSessionOff = Effect.fn("Memory.setSessionOff")(function* (sessionID: string, off: boolean) {
      const s = yield* InstanceState.get(state)
      if (off) s.sessionOff.add(sessionID)
      else s.sessionOff.delete(sessionID)
    })

    const scopes = Effect.fn("Memory.scopes")(function* () {
      const cfg = yield* config.get()
      const list = cfg.memory?.scope ?? ["project"]
      return [...new Set(list)] as MemoryStore.Scope[]
    })

    /** Answer the sidecar's sampling request with the resolved memory model, never its choice. */
    const sampler = Effect.fn("Memory.sampler")(function* (model: MemoryModel.Model) {
      const resolved = yield* provider.getModel(model.providerID as never, model.modelID as never)
      const bridge = yield* EffectBridge.make()
      const sample: MemorySidecar.Sample = (input) => {
        const sessionID = SessionID.descending()
        return bridge.promise(
          llm
            .stream({
              agent: MEMORY_AGENT,
              user: {
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: MEMORY_AGENT.name,
                model: { providerID: resolved.providerID, modelID: resolved.id },
              },
              system: input.system ? [input.system] : [],
              small: true,
              tools: {},
              model: resolved,
              sessionID,
              retries: 2,
              messages: [{ role: "user", content: input.text }],
            })
            .pipe(
              Stream.filter(LLMEvent.is.textDelta),
              Stream.map((event) => event.text),
              Stream.mkString,
            ),
        )
      }
      return sample
    })

    const backend = Effect.fn("Memory.backend")(function* (input: {
      scope: MemoryStore.Scope
      sessionID?: string
      parent: MemoryModel.Model
    }) {
      const verdict = yield* decision(input.sessionID)
      if (!verdict.on) return yield* Effect.fail(new OffError(`Memory is off: ${verdict.reason}`))
      const s = yield* InstanceState.get(state)
      const existing = s.running.get(input.scope)
      if (existing) return yield* Effect.tryPromise({ try: () => existing, catch: toError })

      const cfg = yield* config.get()
      const chosen = yield* Effect.try({
        try: () => {
          MemoryModel.checkEmbedding(cfg.memory)
          const out = MemoryModel.resolve({ memory: cfg.memory, small_model: cfg.small_model, parent: input.parent })
          MemoryModel.checkResidency(out, AuditLog.residency(cfg))
          return out
        },
        catch: toError,
      })
      const sample = yield* sampler(chosen.model)
      const limits = {
        maxFacts: cfg.memory?.limits?.max_facts ?? MemoryBackend.DEFAULT_LIMITS.maxFacts,
        maxFactChars: cfg.memory?.limits?.max_fact_chars ?? MemoryBackend.DEFAULT_LIMITS.maxFactChars,
      }
      const starting = (async () => {
        const root = await MemoryStore.ensure(input.scope, s.worktree)
        const handle = await MemorySidecar.start({ root, sample })
        return MemoryBackend.cognee({ root, handle, limits })
      })()
      s.running.set(input.scope, starting)
      starting.catch(() => s.running.delete(input.scope))
      return yield* Effect.tryPromise({ try: () => starting, catch: toError })
    })

    return Service.of({ decision, setSessionOff, scopes, backend })
  }),
)

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, Provider.node, LLM.node] })

export * as Memory from "."
