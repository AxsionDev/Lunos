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
import type { MemoryBundle } from "./bundle"
import { MemoryExternal } from "./external"
import { MemoryGuard } from "./guard"
import { MemoryKey } from "./key"
import { MemoryLifecycle } from "./lifecycle"
import { MemoryNotes } from "./notes"
import { MemoryRecall } from "./recall"
import { MemoryModel } from "./model"
import { MemorySidecar } from "./sidecar"
import { MemorySources } from "./sources"
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

/** Where a memory operation came from, for the audit trail (XCOD-136). */
export type Origin = "cli" | "tui" | "tool" | "turn" | "import" | "start"

/** One scope's ledger health, for `lunos memory status` and `verify` (XCOD-136). */
export interface Health {
  scope: MemoryStore.Scope
  facts: number
  counts: Record<MemoryLifecycle.State, number>
  problems: MemoryStore.Problem[]
  encrypted: number
  unsealed: number
  /** Set when the ledger can't be read at all (the encryption key is missing, say). */
  error?: string
}

/** Where memory is kept and whether it can be reached, for `lunos memory status` (XCOD-134). */
export interface Where {
  type: "embedded" | MemoryExternal.Kind
  /** External only. */
  host?: string
  jurisdiction?: string
  tls?: MemoryExternal.Checked["tls"]
  readOnly: boolean
  warnings: string[]
  /** "ok (server)", why it wasn't opened, or the connection error. External only. */
  connection?: string
  scopes: { scope: MemoryStore.Scope; facts?: number; lastWrite?: string; error?: string }[]
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
    /** XCOD-136: observed (a person said it, or it was read from a file) or inferred. */
    kind?: MemoryStore.Kind
    /** XCOD-136: an expiry date for this fact. */
    expires?: string
    /** XCOD-136: the id of an active fact in the same scope that this one replaces; a person approved it. */
    replaces?: string
  }) => Effect.Effect<MemoryStore.Fact, Error>
  /**
   * Facts closest to a query, from every configured scope, closest first. Only active facts, unless
   * `history` asks for outdated ones too. Recorded in the audit log as `memory.recall` (ids and
   * counts, never the query).
   */
  readonly search: (input: {
    query: string
    sessionID?: string
    parent: MemoryModel.Model
    limit?: number
    history?: boolean
    origin?: Origin
  }) => Effect.Effect<{ scope: MemoryStore.Scope; facts: MemoryBackend.Recalled[]; graph: string }[], Error>
  /**
   * The `<memory>` block for a user message, computed once per message and cached, so the steps of
   * one turn don't each start a recall. Undefined when memory is off, empty, or unavailable: a
   * failing recall never stops a turn.
   */
  /** Every stored fact in a scope, from the ledger. Never starts the engine. */
  readonly facts: (scope: MemoryStore.Scope) => Effect.Effect<MemoryStore.Fact[], Error>
  /** Remove one fact, from whichever scope holds it. False if no scope does. */
  readonly forget: (input: {
    id: string
    parent: MemoryModel.Model
    sessionID?: string
    origin?: Origin
  }) => Effect.Effect<{ scope: MemoryStore.Scope; fact: MemoryStore.Fact } | undefined, Error>
  /**
   * Mark an active fact outdated (XCOD-136), optionally replaced by another active fact in the same
   * scope. Kept, with `invalid_at`, but no longer recalled. Fails if either id isn't an active fact.
   */
  readonly outdate: (input: {
    id: string
    by?: string
    parent: MemoryModel.Model
    sessionID?: string
    origin?: Origin
  }) => Effect.Effect<{ scope: MemoryStore.Scope; fact: MemoryStore.Fact }, Error>
  /** Each scope's ledger health. With `audit`, a scope with problems is recorded as `memory.verify_failed`. */
  readonly verify: (input?: { origin?: Origin; audit?: boolean }) => Effect.Effect<Health[]>
  /** Accept a scope's ledger as it is now: recompute every integrity hash. For after a person reviewed it. */
  readonly reseal: (scope: MemoryStore.Scope) => Effect.Effect<number, Error>
  /** The retention policy and the encryption mode in effect. */
  readonly policy: () => Effect.Effect<{ retention: MemoryLifecycle.Retention; encryption: MemoryStore.Mode }>
  /** Delete a scope's memory directory, and nothing else. Hand-written notes are kept. */
  readonly purge: (scope: MemoryStore.Scope, origin?: Origin) => Effect.Effect<number, Error>
  /**
   * The engine's graph for a scope, for export (XCOD-132). Uses the running sidecar if there is one;
   * otherwise starts one for this read only, with no model (the read makes no model call, and hand-
   * written notes are not synced, so exporting never changes memory), and stops it again. Fails
   * when memory is off: off means no memory process starts.
   */
  readonly graph: (scope: MemoryStore.Scope) => Effect.Effect<MemoryBundle.RawGraph, Error>
  /**
   * Store one imported fact (XCOD-133), keeping its original provenance as `origin` and marking it
   * imported. Runs the same content screens as `remember` (size, secrets, instruction-shaped text)
   * again at write time; there is no turn to taint-check. The caller has shown a preview and had it
   * approved.
   */
  readonly storeImported: (input: {
    scope: MemoryStore.Scope
    text: string
    origin?: MemoryStore.Provenance
    imported: MemoryStore.Imported
    parent: MemoryModel.Model
    /** XCOD-136: lifecycle fields the bundle carried (status, kind, expiry, validity). */
    lifecycle?: Pick<MemoryBackend.Extra, "status" | "kind" | "expires" | "valid_from" | "invalid_at">
    /**
     * XCOD-134 migration: store the fact as it was, with its own id, provenance and import record,
     * instead of marking it imported. It is still screened like any import.
     */
    verbatim?: Pick<MemoryStore.Fact, "id" | "provenance" | "origin" | "imported">
  }) => Effect.Effect<MemoryStore.Fact, Error>
  /** Point an imported outdated fact at the imported fact that replaced it (ids are new on import). */
  readonly link: (input: { scope: MemoryStore.Scope; id: string; by: string }) => Effect.Effect<void, Error>
  /**
   * Re-read the hand-written notes into project memory now (an import just wrote some), starting
   * project memory if it isn't running. Returns paragraphs that couldn't be stored.
   */
  readonly syncNotes: (parent: MemoryModel.Model) => Effect.Effect<string[], Error>
  /** Stop a scope's sidecar if it is running, so its database files can be copied. */
  readonly release: (scope: MemoryStore.Scope) => Effect.Effect<void>
  /**
   * XCOD-134: read and write embedded memory whatever `memory.backend` says, until unpinned. For
   * `lunos memory migrate`, which exports from embedded memory and imports into the configured
   * external database in one process.
   */
  readonly pin: (target: "embedded" | undefined) => Effect.Effect<void>
  /**
   * The configured backend type (ignoring a pin), whether it is recall-only, and, for an external
   * database the pre-connection checks refuse (residency, TLS, jurisdiction), why.
   */
  readonly target: () => Effect.Effect<{
    type: "embedded" | MemoryExternal.Kind
    readOnly: boolean
    refused?: string
  }>
  /** Where memory is kept, whether it can be reached, and each scope's fact count and last write. */
  readonly where: () => Effect.Effect<Where>
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
  /** Keyed by `<backend type>:<scope>`, so a migration's embedded and external backends never mix. */
  running: Map<string, Promise<MemoryBackend.Backend>>
  pinned?: "embedded"
  recalled: Map<string, string | undefined>
  worktree: string
  /** The last integrity problems recorded per ledger, so `memory.verify_failed` isn't repeated. */
  reported: Map<string, string>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const sources = yield* MemorySources.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Memory.state")(function* (ctx) {
        const state: State = {
          sessionOff: new Set(),
          running: new Map(),
          recalled: new Map(),
          worktree: MemoryStore.projectRoot(ctx),
          reported: new Map(),
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

    const limitsOf = Effect.fn("Memory.limits")(function* () {
      const cfg = yield* config.get()
      return {
        maxFacts: cfg.memory?.limits?.max_facts ?? MemoryBackend.DEFAULT_LIMITS.maxFacts,
        maxFactChars: cfg.memory?.limits?.max_fact_chars ?? MemoryBackend.DEFAULT_LIMITS.maxFactChars,
      }
    })

    const policy = Effect.fn("Memory.policy")(function* () {
      const cfg = yield* config.get()
      return {
        retention: MemoryLifecycle.retention(cfg.memory),
        encryption: (cfg.memory?.encryption ?? "off") as MemoryStore.Mode,
      }
    })

    /** The external backend block in effect, or undefined for embedded memory (or while pinned). */
    const external = Effect.fn("Memory.external")(function* () {
      const cfg = yield* config.get()
      const s = yield* InstanceState.get(state)
      if (s.pinned) return undefined
      return MemoryExternal.configured(cfg.memory) ? cfg.memory : undefined
    })

    const keyOf = Effect.fn("Memory.key")(function* (scope: MemoryStore.Scope) {
      const cfg = yield* config.get()
      const s = yield* InstanceState.get(state)
      return `${s.pinned ?? MemoryExternal.type(cfg.memory)}:${scope}`
    })

    /** The running external backend for a scope (starting it), for the operations only it has. */
    const externalOf = Effect.fn("Memory.externalOf")(function* (scope: MemoryStore.Scope, sessionID?: string) {
      const store = yield* backend({ scope, sessionID })
      return store as MemoryExternal.External
    })

    /** Record a ledger's integrity problems once per distinct set, never with fact text. */
    const report = (s: State, scope: MemoryStore.Scope, problems: MemoryStore.Problem[], origin: Origin) => {
      const key = MemoryStore.dir(scope, s.worktree)
      const signature = problems.map((problem) => `${problem.line}:${problem.id ?? ""}:${problem.reason}`).join("\n")
      if (!problems.length) {
        s.reported.delete(key)
        return
      }
      if (s.reported.get(key) === signature) return
      s.reported.set(key, signature)
      AuditLog.emit("memory.verify_failed", {
        scope,
        source: origin,
        count: problems.length,
        ids: problems.map((problem) => problem.id ?? `line ${problem.line}`),
        lines: problems.map((problem) => String(problem.line)),
      })
    }

    const backend = Effect.fn("Memory.backend")(function* (input: {
      scope: MemoryStore.Scope
      sessionID?: string
      /** The main agent's model. Embedded memory needs it for extraction; an external database doesn't. */
      parent?: MemoryModel.Model
    }) {
      // Off means off: this is checked before anything else, so no sidecar starts and no database
      // connection is opened (XCOD-134).
      const verdict = yield* decision(input.sessionID)
      if (!verdict.on) return yield* Effect.fail(new OffError(`Memory is off: ${verdict.reason}`))
      const s = yield* InstanceState.get(state)
      const key = yield* keyOf(input.scope)
      const existing = s.running.get(key)
      if (existing) return yield* Effect.tryPromise({ try: () => existing, catch: toError })

      const cfg = yield* config.get()
      const outside = yield* external()
      if (outside) {
        // XCOD-134: jurisdiction, residency, URL and TLS are checked before the driver is loaded.
        const checked = yield* Effect.try({
          try: () => MemoryExternal.gate({ memory: outside, residency: AuditLog.residency(cfg) }),
          catch: toError,
        })
        for (const warning of checked.warnings) yield* Effect.logWarning(warning)
        const limits = yield* limitsOf()
        const { retention } = yield* policy()
        const scope = input.scope
        const starting = (async () => {
          const store = await MemoryExternal.neo4j({ checked, scope, worktree: s.worktree, limits, retention })
          try {
            const swept = await store.sweep(MemoryLifecycle.now())
            if (swept.purged.length)
              AuditLog.emit("memory.purge", {
                scope,
                source: "start",
                reason: "expired",
                count: swept.purged.length,
                ids: swept.purged.map((fact) => fact.id),
              })
          } catch (error) {
            await store.close()
            throw error
          }
          return store as MemoryBackend.Backend
        })()
        s.running.set(key, starting)
        starting.catch(() => s.running.delete(key))
        return yield* Effect.tryPromise({ try: () => starting, catch: toError })
      }
      if (!input.parent) return yield* Effect.fail(new Error("Embedded memory needs a model to start"))
      const chosen = yield* Effect.try({
        try: () => {
          MemoryModel.checkEmbedding(cfg.memory, AuditLog.residency(cfg))
          const out = MemoryModel.resolve({ memory: cfg.memory, small_model: cfg.small_model, parent: input.parent! })
          MemoryModel.checkResidency(out, AuditLog.residency(cfg))
          return out
        },
        catch: toError,
      })
      const sample = yield* sampler(chosen.model)
      const limits = yield* limitsOf()
      const { retention, encryption } = yield* policy()
      const scope = input.scope
      const starting = (async () => {
        const root = await MemoryStore.ensure(scope, s.worktree)
        // XCOD-136, before anything else touches the ledger: seal a legacy ledger, apply the
        // encryption setting (failing closed if the key is missing), and record any integrity
        // problems. Quarantined facts stay in the ledger but are never recalled.
        await MemoryStore.prepare(root, encryption)
        report(s, scope, (await MemoryStore.load(root)).problems, "start")
        const handle = await MemorySidecar.start({ root, sample })
        const backend = MemoryBackend.cognee({ root, handle, limits, mode: encryption, retention })
        try {
          const swept = await backend.sweep(MemoryLifecycle.now())
          if (swept.purged.length)
            AuditLog.emit("memory.purge", {
              scope,
              source: "start",
              reason: "expired",
              count: swept.purged.length,
              ids: swept.purged.map((fact) => fact.id),
            })
          if (scope === "project") await MemoryNotes.sync({ backend, worktree: s.worktree })
        } catch (error) {
          await handle.close().catch(() => {})
          throw error
        }
        return backend
      })()
      s.running.set(key, starting)
      starting.catch(() => s.running.delete(key))
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
      kind?: MemoryStore.Kind
      expires?: string
      replaces?: string
    }) {
      const s = yield* InstanceState.get(state)
      const refusal =
        MemoryGuard.taint(input.messages, s.worktree) ??
        MemoryGuard.provenance(input.messages, input.fact, input.source) ??
        MemoryGuard.secret(input.fact) ??
        MemoryGuard.instructions(input.fact)
      if (refusal) return yield* Effect.fail(new MemoryGuard.RefusedError(`Not remembered: ${refusal}.`))
      const store = yield* backend({ scope: input.scope, sessionID: input.sessionID, parent: input.parent })
      if (input.replaces) {
        const target = (yield* facts(input.scope)).find((item) => item.id === input.replaces)
        if (!target || target.quarantined || !MemoryStore.isActive(target))
          return yield* Effect.fail(
            new Error(
              `Not remembered: ${input.replaces} is not an active fact in ${input.scope} memory, so it can't be replaced.`,
            ),
          )
      }
      const fact = yield* Effect.tryPromise({
        try: () =>
          store.remember(
            input.fact,
            {
              sessionID: input.sessionID,
              agent: input.agent,
              source: input.source,
              date: new Date().toISOString(),
            },
            {
              kind: input.kind ?? "inferred",
              ...(input.expires ? { expires: input.expires } : {}),
            },
          ),
        catch: toError,
      })
      AuditLog.emit("memory.remember", {
        session: input.sessionID,
        agent: input.agent,
        scope: input.scope,
        id: fact.id,
        source: input.source,
        kind: fact.kind,
        chars: fact.text.length,
        expires: fact.expires,
        replaces: input.replaces,
      })
      s.recalled.clear()
      if (input.replaces && input.replaces !== fact.id) {
        const outdated = yield* Effect.tryPromise({
          try: () => store.outdate(input.replaces!, { by: fact.id, at: new Date() }),
          catch: toError,
        })
        if (outdated)
          AuditLog.emit("memory.outdate", {
            scope: input.scope,
            id: outdated.id,
            by: fact.id,
            session: input.sessionID,
            source: "tool",
          })
        return { ...fact, replaces: input.replaces }
      }
      return fact
    })

    const storeImported = Effect.fn("Memory.storeImported")(function* (input: {
      scope: MemoryStore.Scope
      text: string
      origin?: MemoryStore.Provenance
      imported: MemoryStore.Imported
      parent: MemoryModel.Model
      lifecycle?: Pick<MemoryBackend.Extra, "status" | "kind" | "expires" | "valid_from" | "invalid_at">
      verbatim?: Pick<MemoryStore.Fact, "id" | "provenance" | "origin" | "imported">
    }) {
      const s = yield* InstanceState.get(state)
      const refusal = MemoryGuard.check(input.text, yield* limitsOf())
      if (refusal) return yield* Effect.fail(new MemoryGuard.RefusedError(`Not imported: ${refusal}.`))
      const store = yield* backend({ scope: input.scope, parent: input.parent })
      const verbatim = input.verbatim
      const fact = yield* Effect.tryPromise({
        try: () =>
          verbatim
            ? store.remember(input.text, verbatim.provenance, {
                id: verbatim.id,
                origin: verbatim.origin,
                imported: verbatim.imported,
                ...input.lifecycle,
              })
            : store.remember(
                input.text,
                {
                  // Never "notes": the notes sync forgets any notes fact whose paragraph it can't find.
                  sessionID: "import",
                  agent: "import",
                  source: input.imported.from,
                  date: input.imported.date,
                },
                { origin: input.origin, imported: input.imported, ...input.lifecycle },
              ),
        catch: toError,
      })
      s.recalled.clear()
      return fact
    })

    const link = Effect.fn("Memory.link")(function* (input: { scope: MemoryStore.Scope; id: string; by: string }) {
      if (yield* external()) {
        const store = yield* externalOf(input.scope)
        return yield* Effect.tryPromise({
          try: () =>
            store.rewrite((items) =>
              items.map((item) =>
                item.id === input.id
                  ? { ...item, replaced_by: input.by }
                  : item.id === input.by
                    ? { ...item, replaces: input.id }
                    : item,
              ),
            ),
          catch: toError,
        })
      }
      const s = yield* InstanceState.get(state)
      const { encryption } = yield* policy()
      const root = MemoryStore.dir(input.scope, s.worktree)
      yield* Effect.tryPromise({
        try: () =>
          MemoryStore.rewrite(
            root,
            (items) =>
              items.map((item) =>
                item.id === input.id
                  ? { ...item, replaced_by: input.by }
                  : item.id === input.by
                    ? { ...item, replaces: input.id }
                    : item,
              ),
            encryption,
          ),
        catch: toError,
      })
    })

    const syncNotes = Effect.fn("Memory.syncNotes")(function* (parent: MemoryModel.Model) {
      // XCOD-134: hand-written notes stay in the repository; they are not copied into a shared
      // database, where each checkout's sync would forget the paragraphs the others don't have.
      if (yield* external()) return [] as string[]
      const s = yield* InstanceState.get(state)
      const store = yield* backend({ scope: "project", parent })
      const result = yield* Effect.tryPromise({
        try: () => MemoryNotes.sync({ backend: store, worktree: s.worktree }),
        catch: toError,
      })
      s.recalled.clear()
      return result.skipped
    })

    const search = Effect.fn("Memory.search")(function* (input: {
      query: string
      sessionID?: string
      parent: MemoryModel.Model
      limit?: number
      history?: boolean
      origin?: Origin
    }) {
      const s = yield* InstanceState.get(state)
      const results: { scope: MemoryStore.Scope; facts: MemoryBackend.Recalled[]; graph: string }[] = []
      for (const scope of yield* scopes()) {
        // Don't start a sidecar just to learn that a scope is empty. A ledger that can't be read
        // (encrypted, key missing) fails here: memory must never look empty instead.
        if (!(yield* external())) {
          const stored = yield* Effect.tryPromise({
            try: () => MemoryStore.facts(MemoryStore.dir(scope, s.worktree)),
            catch: toError,
          })
          if (
            stored.length === 0 &&
            !(scope === "project" && (yield* Effect.promise(() => MemoryNotes.any(s.worktree))))
          )
            continue
        }
        const store = yield* backend({ scope, sessionID: input.sessionID, parent: input.parent })
        const found = yield* Effect.tryPromise({
          try: () => store.recall(input.query, input.limit ?? 10, { history: input.history }),
          catch: toError,
        })
        results.push({ scope, ...found })
      }
      AuditLog.emit("memory.recall", {
        session: input.sessionID,
        source: input.origin ?? "tool",
        history: input.history || undefined,
        scopes: results.map((result) => result.scope),
        count: results.reduce((sum, result) => sum + result.facts.length, 0),
        ids: results.flatMap((result) => result.facts.map((item) => item.fact.id)),
      })
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
      // XCOD-135: local memory and external sources are recalled side by side; either failing
      // leaves the other's results in the block.
      const [local, external] = yield* Effect.all(
        [
          search({
            query: input.query,
            sessionID: input.sessionID,
            parent: input.parent,
            origin: "turn",
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("memory recall failed", { error: error.message }).pipe(Effect.as([])),
            ),
          ),
          sources.recall({ sessionID: input.sessionID, query: input.query }),
        ],
        { concurrency: 2 },
      )
      yield* Effect.logInfo("memory recalled", {
        session: input.sessionID,
        facts: local.flatMap((result) => result.facts.map((item) => `${result.scope}:${item.fact.id}`)),
        sources: external.labels,
      })
      const text = MemoryRecall.block(local, cfg.memory?.retrieval?.max_tokens, external)
      s.recalled.set(input.userMessageID, text)
      return text
    })

    const facts = Effect.fn("Memory.facts")(function* (scope: MemoryStore.Scope) {
      // XCOD-134: in an external database the facts are the ledger; reading them needs memory on.
      if (yield* external()) {
        const store = yield* backend({ scope })
        return yield* Effect.tryPromise({ try: () => store.list(), catch: toError })
      }
      const s = yield* InstanceState.get(state)
      return yield* Effect.tryPromise({
        try: () => MemoryStore.facts(MemoryStore.dir(scope, s.worktree)),
        catch: toError,
      })
    })

    const forget = Effect.fn("Memory.forget")(function* (input: {
      id: string
      parent: MemoryModel.Model
      sessionID?: string
      origin?: Origin
    }) {
      const outside = yield* external()
      for (const scope of outside ? yield* scopes() : (["project", "user"] as const)) {
        const s0 = yield* InstanceState.get(state)
        const ledger: Pick<MemoryStore.Ledger, "facts" | "problems"> = outside
          ? { facts: yield* facts(scope), problems: [] }
          : yield* Effect.tryPromise({
              try: () => MemoryStore.load(MemoryStore.dir(scope, s0.worktree)),
              catch: toError,
            })
        const fact =
          ledger.facts.find((item) => item.id === input.id) ??
          // An unreadable (quarantined) line can be forgotten by the id it claims.
          (ledger.problems.some((problem) => problem.id === input.id)
            ? ({
                id: input.id,
                datasetID: "",
                text: "",
                provenance: { sessionID: "", agent: "", source: "", date: "" },
                quarantined: "unreadable",
              } satisfies MemoryStore.Fact)
            : undefined)
        if (!fact) continue
        const store = yield* backend({ scope, sessionID: input.sessionID, parent: input.parent })
        yield* Effect.tryPromise({ try: () => store.forget(fact.id), catch: toError })
        AuditLog.emit("memory.forget", { scope, id: fact.id, session: input.sessionID, source: input.origin ?? "cli" })
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

    const release = Effect.fn("Memory.release")(function* (scope: MemoryStore.Scope) {
      const s = yield* InstanceState.get(state)
      for (const [key, running] of [...s.running]) {
        if (!key.endsWith(`:${scope}`)) continue
        s.running.delete(key)
        yield* Effect.promise(() => running.then((item) => item.close()).catch(() => {}))
      }
    })

    const graph = Effect.fn("Memory.graph")(function* (scope: MemoryStore.Scope) {
      const verdict = yield* decision()
      if (!verdict.on) return yield* Effect.fail(new OffError(`Memory is off: ${verdict.reason}`))
      const s = yield* InstanceState.get(state)
      if (yield* external()) {
        const store = yield* backend({ scope })
        return yield* Effect.tryPromise({ try: () => store.graph(), catch: toError })
      }
      const running = s.running.get(yield* keyOf(scope))
      if (running)
        return yield* Effect.tryPromise({ try: () => running.then((backend) => backend.graph()), catch: toError })
      const root = MemoryStore.dir(scope, s.worktree)
      return yield* Effect.tryPromise({
        try: async () => {
          const handle = await MemorySidecar.start({
            root,
            sample: async () => {
              throw new Error("Reading the memory graph makes no model calls")
            },
          })
          try {
            return await MemoryBackend.cognee({ root, handle, limits: MemoryBackend.DEFAULT_LIMITS }).graph()
          } finally {
            await handle.close()
          }
        },
        catch: toError,
      })
    })

    const purge = Effect.fn("Memory.purge")(function* (scope: MemoryStore.Scope, origin: Origin = "cli") {
      const s = yield* InstanceState.get(state)
      if (yield* external()) {
        const store = yield* externalOf(scope)
        const count = yield* Effect.tryPromise({ try: () => store.purge(), catch: toError })
        AuditLog.emit("memory.purge", { scope, count, reason: "command", source: origin })
        s.recalled.clear()
        return count
      }
      yield* release(scope)
      const root = MemoryStore.dir(scope, s.worktree)
      // Purging must work even when the ledger can't be read (its key is gone): count the lines.
      const count = yield* Effect.promise(() =>
        fs
          .readFile(MemoryStore.ledgerFile(root), "utf8")
          .then((text) => text.split("\n").filter((line) => line.trim()).length)
          .catch(() => 0),
      )
      yield* Effect.tryPromise({ try: () => fs.rm(root, { recursive: true, force: true }), catch: toError })
      AuditLog.emit("memory.purge", { scope, count, reason: "command", source: origin })
      s.recalled.clear()
      return count
    })

    const outdate = Effect.fn("Memory.outdate")(function* (input: {
      id: string
      by?: string
      parent: MemoryModel.Model
      sessionID?: string
      origin?: Origin
    }) {
      for (const scope of ["project", "user"] as const) {
        const all = yield* facts(scope)
        const fact = all.find((item) => item.id === input.id)
        if (!fact) continue
        if (fact.quarantined)
          return yield* Effect.fail(new Error(`${input.id} is quarantined (${fact.quarantined}); forget it instead`))
        if (!MemoryStore.isActive(fact))
          return yield* Effect.fail(new Error(`${input.id} is already outdated (since ${fact.invalid_at ?? "?"})`))
        if (input.by !== undefined) {
          if (input.by === input.id) return yield* Effect.fail(new Error("A fact can't replace itself"))
          const by = all.find((item) => item.id === input.by)
          if (!by || by.quarantined || !MemoryStore.isActive(by))
            return yield* Effect.fail(
              new Error(`--by ${input.by} is not an active fact in ${scope} memory, where ${input.id} is`),
            )
        }
        const store = yield* backend({ scope, sessionID: input.sessionID, parent: input.parent })
        const updated = yield* Effect.tryPromise({
          try: () => store.outdate(input.id, { by: input.by, at: new Date() }),
          catch: toError,
        })
        if (!updated) return yield* Effect.fail(new Error(`${input.id} could not be marked outdated`))
        AuditLog.emit("memory.outdate", {
          scope,
          id: input.id,
          by: input.by,
          session: input.sessionID,
          source: input.origin ?? "cli",
        })
        const s = yield* InstanceState.get(state)
        s.recalled.clear()
        return { scope, fact: updated }
      }
      return yield* Effect.fail(new Error(`No fact with id ${input.id}`))
    })

    const verify = Effect.fn("Memory.verify")(function* (input: { origin?: Origin; audit?: boolean } = {}) {
      const s = yield* InstanceState.get(state)
      const { retention } = yield* policy()
      const at = MemoryLifecycle.now()
      const out: Health[] = []
      if (yield* external()) {
        for (const scope of yield* scopes()) {
          const counts: Record<MemoryLifecycle.State, number> = {
            active: 0,
            outdated: 0,
            expired: 0,
            purge: 0,
            quarantined: 0,
          }
          const got = yield* externalOf(scope).pipe(
            Effect.flatMap((store) => Effect.tryPromise({ try: () => store.list(), catch: toError })),
            Effect.result,
          )
          if (got._tag === "Failure") {
            out.push({ scope, facts: 0, counts, problems: [], encrypted: 0, unsealed: 0, error: got.failure.message })
            continue
          }
          const problems = got.success.flatMap((fact, index) =>
            fact.quarantined ? [{ line: index + 1, id: fact.id, reason: fact.quarantined }] : [],
          )
          for (const fact of got.success) counts[MemoryLifecycle.state(fact, retention, at)]++
          if (input.audit) {
            s.reported.delete(`external:${scope}`)
            if (problems.length)
              AuditLog.emit("memory.verify_failed", {
                scope,
                source: input.origin ?? "cli",
                count: problems.length,
                ids: problems.map((problem) => problem.id),
              })
          }
          out.push({ scope, facts: got.success.length, counts, problems, encrypted: 0, unsealed: 0 })
        }
        return out
      }
      for (const scope of ["project", "user"] as const) {
        const root = MemoryStore.dir(scope, s.worktree)
        const counts: Record<MemoryLifecycle.State, number> = {
          active: 0,
          outdated: 0,
          expired: 0,
          purge: 0,
          quarantined: 0,
        }
        const ledger = yield* Effect.promise(() =>
          MemoryStore.load(root).then(
            (value) => value,
            (error: Error) => error,
          ),
        )
        if (ledger instanceof Error) {
          out.push({ scope, facts: 0, counts, problems: [], encrypted: 0, unsealed: 0, error: ledger.message })
          if (input.audit)
            AuditLog.emit("memory.verify_failed", {
              scope,
              source: input.origin ?? "cli",
              count: 0,
              reason: ledger instanceof MemoryKey.KeyError ? "key" : "unreadable",
            })
          continue
        }
        for (const fact of ledger.facts) counts[MemoryLifecycle.state(fact, retention, at)]++
        counts.quarantined += ledger.problems.filter(
          (problem) => !ledger.facts.some((fact) => fact.id === problem.id),
        ).length
        if (input.audit) {
          s.reported.delete(root)
          report(s, scope, ledger.problems, input.origin ?? "cli")
        }
        out.push({
          scope,
          facts: ledger.facts.length,
          counts,
          problems: ledger.problems,
          encrypted: ledger.encrypted,
          unsealed: ledger.unsealed,
        })
      }
      return out
    })

    const reseal = Effect.fn("Memory.reseal")(function* (scope: MemoryStore.Scope) {
      const s = yield* InstanceState.get(state)
      if (yield* external()) {
        const store = yield* externalOf(scope)
        const before = (yield* Effect.tryPromise({ try: () => store.list(), catch: toError })).filter(
          (fact) => fact.quarantined,
        ).length
        yield* Effect.tryPromise({ try: () => store.rewrite((items) => items), catch: toError })
        s.recalled.clear()
        return before
      }
      const { encryption } = yield* policy()
      const root = MemoryStore.dir(scope, s.worktree)
      const before = yield* Effect.tryPromise({ try: () => MemoryStore.load(root), catch: toError })
      yield* Effect.tryPromise({
        try: () => MemoryStore.rewrite(root, (items) => items, encryption, { reseal: true }),
        catch: toError,
      })
      s.reported.delete(root)
      s.recalled.clear()
      return before.problems.length
    })

    const pin = Effect.fn("Memory.pin")(function* (target: "embedded" | undefined) {
      const s = yield* InstanceState.get(state)
      s.pinned = target
      s.recalled.clear()
    })

    const target = Effect.fn("Memory.target")(function* () {
      const cfg = yield* config.get()
      const type = MemoryExternal.type(cfg.memory)
      const readOnly = MemoryExternal.readOnly(cfg.memory)
      if (type === "embedded") return { type, readOnly }
      try {
        MemoryExternal.gate({ memory: cfg.memory, residency: AuditLog.residency(cfg) })
        return { type, readOnly }
      } catch (error) {
        return { type, readOnly, refused: error instanceof Error ? error.message : String(error) }
      }
    })

    const where = Effect.fn("Memory.where")(function* () {
      const cfg = yield* config.get()
      const s = yield* InstanceState.get(state)
      const configured = yield* scopes()
      const kind = MemoryExternal.type(cfg.memory)
      if (kind === "embedded") {
        const out: Where = { type: "embedded", readOnly: false, warnings: [], scopes: [] }
        for (const scope of configured) {
          const got = yield* Effect.promise(() =>
            MemoryStore.facts(MemoryStore.dir(scope, s.worktree)).then(
              (items) => items,
              (error: Error) => error,
            ),
          )
          if (got instanceof Error) out.scopes.push({ scope, error: got.message })
          else
            out.scopes.push({
              scope,
              facts: got.length,
              lastWrite: got
                .map((fact) => fact.provenance.date)
                .toSorted()
                .at(-1),
            })
        }
        return out
      }
      const block = MemoryExternal.configured(cfg.memory)!
      const out: Where = {
        type: kind,
        jurisdiction: block.jurisdiction,
        readOnly: block.read_only === true,
        warnings: [],
        scopes: [],
      }
      const checked = yield* Effect.try({
        try: () => MemoryExternal.gate({ memory: cfg.memory, residency: AuditLog.residency(cfg) }),
        catch: toError,
      }).pipe(Effect.result)
      if (checked._tag === "Failure") {
        out.connection = `refused before connecting: ${checked.failure.message}`
        return out
      }
      Object.assign(out, { host: checked.success.host, tls: checked.success.tls, warnings: checked.success.warnings })
      const verdict = yield* decision()
      if (!verdict.on) {
        out.connection = `not opened: memory is off (${verdict.reason})`
        return out
      }
      for (const scope of configured) {
        const got = yield* externalOf(scope).pipe(
          Effect.flatMap((store) => Effect.tryPromise({ try: () => store.health(), catch: toError })),
          Effect.result,
        )
        if (got._tag === "Failure") {
          out.scopes.push({ scope, error: got.failure.message })
          continue
        }
        out.connection = `ok (${got.success.server})`
        out.scopes.push({ scope, facts: got.success.facts, lastWrite: got.success.lastWrite })
      }
      out.connection ??= "failed"
      return out
    })

    return Service.of({
      pin,
      target,
      where,
      decision,
      setSessionOff,
      scopes,
      backend,
      remember,
      search,
      facts,
      forget,
      purge,
      outdate,
      verify,
      reseal,
      policy,
      graph,
      release,
      recallFor,
      storeImported,
      link,
      syncNotes,
    })
  }),
)

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, Provider.node, LLM.node, MemorySources.node],
})

export * as Memory from "."
