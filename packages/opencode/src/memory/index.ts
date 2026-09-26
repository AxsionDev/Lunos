import fs from "node:fs/promises"
import path from "node:path"
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
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MemoryBackend } from "./backend"
import { MemoryGuard } from "./guard"
import { MemoryNotes } from "./notes"
import { MemoryRecall } from "./recall"
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
  /**
   * Store one fact, after the §5 checks: refused when the turn brought in outside content or the
   * fact looks like a secret. The caller has already had a person approve it.
   */
  readonly remember: (input: {
    fact: string
    source: string
    scope: MemoryStore.Scope
    sessionID: string
    agent: string
    parent: MemoryModel.Model
    messages: readonly SessionV1.WithParts[]
  }) => Effect.Effect<MemoryStore.Fact, Error>
  /** Facts closest to a query, from every configured scope, closest first. */
  readonly search: (input: {
    query: string
    sessionID?: string
    parent: MemoryModel.Model
    limit?: number
  }) => Effect.Effect<{ scope: MemoryStore.Scope; facts: MemoryBackend.Recalled[]; graph: string }[], Error>
  /**
   * The `<memory>` block for a user message, computed once per message and cached, so the steps of
   * one turn don't each start a recall. Undefined when memory is off, empty, or unavailable: a
   * failing recall never stops a turn.
   */
  /** Every stored fact in a scope, from the ledger. Never starts the engine. */
  readonly facts: (scope: MemoryStore.Scope) => Effect.Effect<MemoryStore.Fact[]>
  /** Remove one fact, from whichever scope holds it. False if no scope does. */
  readonly forget: (input: {
    id: string
    parent: MemoryModel.Model
    sessionID?: string
  }) => Effect.Effect<{ scope: MemoryStore.Scope; fact: MemoryStore.Fact } | undefined, Error>
  /** Delete a scope's memory directory, and nothing else. Hand-written notes are kept. */
  readonly purge: (scope: MemoryStore.Scope) => Effect.Effect<number, Error>
  readonly recallFor: (input: {
    sessionID: string
    userMessageID: string
    query: string
    parent: MemoryModel.Model
  }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

interface State {
  sessionOff: Set<string>
  running: Map<MemoryStore.Scope, Promise<MemoryBackend.Backend>>
  recalled: Map<string, string | undefined>
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
        const state: State = {
          sessionOff: new Set(),
          running: new Map(),
          recalled: new Map(),
          worktree: MemoryStore.projectRoot(ctx),
        }
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
        const backend = MemoryBackend.cognee({ root, handle, limits })
        if (input.scope === "project") await MemoryNotes.sync({ backend, worktree: s.worktree })
        return backend
      })()
      s.running.set(input.scope, starting)
      starting.catch(() => s.running.delete(input.scope))
      return yield* Effect.tryPromise({ try: () => starting, catch: toError })
    })

    const remember = Effect.fn("Memory.remember")(function* (input: {
      fact: string
      source: string
      scope: MemoryStore.Scope
      sessionID: string
      agent: string
      parent: MemoryModel.Model
      messages: readonly SessionV1.WithParts[]
    }) {
      const s = yield* InstanceState.get(state)
      const refusal = MemoryGuard.taint(input.messages, s.worktree) ?? MemoryGuard.secret(input.fact)
      if (refusal) return yield* Effect.fail(new MemoryGuard.RefusedError(`Not remembered: ${refusal}.`))
      const store = yield* backend({ scope: input.scope, sessionID: input.sessionID, parent: input.parent })
      const fact = yield* Effect.tryPromise({
        try: () =>
          store.remember(input.fact, {
            sessionID: input.sessionID,
            agent: input.agent,
            source: input.source,
            date: new Date().toISOString(),
          }),
        catch: toError,
      })
      AuditLog.emit("memory.write", {
        session: input.sessionID,
        agent: input.agent,
        scope: input.scope,
        id: fact.id,
        source: input.source,
        chars: fact.text.length,
      })
      s.recalled.clear()
      return fact
    })

    const search = Effect.fn("Memory.search")(function* (input: {
      query: string
      sessionID?: string
      parent: MemoryModel.Model
      limit?: number
    }) {
      const s = yield* InstanceState.get(state)
      const results: { scope: MemoryStore.Scope; facts: MemoryBackend.Recalled[]; graph: string }[] = []
      for (const scope of yield* scopes()) {
        // Don't start a sidecar just to learn that a scope is empty.
        const stored = yield* Effect.promise(() => MemoryStore.facts(MemoryStore.dir(scope, s.worktree)))
        if (stored.length === 0 && !(scope === "project" && (yield* Effect.promise(() => MemoryNotes.any(s.worktree)))))
          continue
        const store = yield* backend({ scope, sessionID: input.sessionID, parent: input.parent })
        const found = yield* Effect.tryPromise({
          try: () => store.recall(input.query, input.limit ?? 10),
          catch: toError,
        })
        results.push({ scope, ...found })
      }
      return results
    })

    const recallFor = Effect.fn("Memory.recallFor")(function* (input: {
      sessionID: string
      userMessageID: string
      query: string
      parent: MemoryModel.Model
    }) {
      const s = yield* InstanceState.get(state)
      if (s.recalled.has(input.userMessageID)) return s.recalled.get(input.userMessageID)
      if (!(yield* decision(input.sessionID)).on) return undefined
      const cfg = yield* config.get()
      const text = yield* search({ query: input.query, sessionID: input.sessionID, parent: input.parent }).pipe(
        Effect.tap((results) =>
          Effect.logInfo("memory recalled", {
            session: input.sessionID,
            facts: results.flatMap((result) => result.facts.map((item) => `${result.scope}:${item.fact.id}`)),
          }),
        ),
        Effect.map((results) => MemoryRecall.block(results, cfg.memory?.retrieval?.max_tokens)),
        Effect.catch((error) =>
          Effect.logWarning("memory recall failed", { error: error.message }).pipe(Effect.as(undefined)),
        ),
      )
      s.recalled.set(input.userMessageID, text)
      return text
    })

    const facts = Effect.fn("Memory.facts")(function* (scope: MemoryStore.Scope) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => MemoryStore.facts(MemoryStore.dir(scope, s.worktree)))
    })

    const forget = Effect.fn("Memory.forget")(function* (input: {
      id: string
      parent: MemoryModel.Model
      sessionID?: string
    }) {
      for (const scope of ["project", "user"] as const) {
        const fact = (yield* facts(scope)).find((item) => item.id === input.id)
        if (!fact) continue
        const store = yield* backend({ scope, sessionID: input.sessionID, parent: input.parent })
        yield* Effect.tryPromise({ try: () => store.forget(fact.id), catch: toError })
        AuditLog.emit("memory.forget", { scope, id: fact.id, session: input.sessionID })
        const s = yield* InstanceState.get(state)
        // A forgotten fact must not live on in memory's own export, where the agent could find it.
        yield* Effect.promise(() =>
          fs.rm(path.join(MemoryStore.exportDir(s.worktree), scope, `${fact.id}.md`), { force: true }),
        )
        s.recalled.clear()
        return { scope, fact }
      }
      return undefined
    })

    const purge = Effect.fn("Memory.purge")(function* (scope: MemoryStore.Scope) {
      const s = yield* InstanceState.get(state)
      const running = s.running.get(scope)
      s.running.delete(scope)
      if (running) yield* Effect.promise(() => running.then((item) => item.close()).catch(() => {}))
      const root = MemoryStore.dir(scope, s.worktree)
      const count = (yield* Effect.promise(() => MemoryStore.facts(root))).length
      yield* Effect.tryPromise({ try: () => fs.rm(root, { recursive: true, force: true }), catch: toError })
      AuditLog.emit("memory.forget", { scope, id: "*", count })
      s.recalled.clear()
      return count
    })

    return Service.of({
      decision,
      setSessionOff,
      scopes,
      backend,
      remember,
      search,
      facts,
      forget,
      purge,
      recallFor,
    })
  }),
)

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, Provider.node, LLM.node] })

export * as Memory from "."
