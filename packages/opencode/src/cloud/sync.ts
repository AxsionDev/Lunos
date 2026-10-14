export * as CloudSync from "./sync"

import fs from "fs/promises"
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Audit } from "@opencode-ai/core/audit"
import type { ConfigSync } from "@opencode-ai/core/config/sync"
import type { EventV2 } from "@opencode-ai/core/event"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { Offline } from "@opencode-ai/core/offline"
import { Residency } from "@opencode-ai/core/residency"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AuditLog } from "@/audit/log"
import { ConfigPolicy } from "@/config/policy"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import type { SessionID } from "@/session/schema"
import { CloudAuth } from "./auth"
import { CloudStore } from "./store"
import { CloudSyncApi } from "./sync-api"
import { CloudSyncQueue } from "./sync-queue"
import { CloudSyncRedact } from "./sync-redact"
import { CloudWorkers } from "./workers"

/**
 * Session sync (lunos-web spec 2026-10-13 §3, C2-C4): after each completed turn, the session's new
 * complete messages go to the user's Lunos space, one numbered chunk at a time.
 *
 * What is uploaded: `{ meta: { title, repoUrl, repoCommit, model, projectId }, info, messages }`,
 * where `info` is the session record without its local `directory` and revert state, and `messages`
 * are the user messages and finished assistant messages not sent before. Bodies are at most 4 MiB.
 *
 * Gates, in order, every turn: offline (`LUNOS_OFFLINE`) → signed out → organisation policy
 * (`sync: false` locked) → this device switched off in the app, or the space full → `sync: false` in
 * this directory → the residency policy, if there is one. Offline and signed-out stop silently; the
 * others write `sync.denied` with the gate, once per session per gate per process, never content.
 *
 * Never uploaded: the contents of `.env*`, `auth.json`, `*.pem`, `*.key`, `id_rsa*` and the
 * `sync.exclude` globs (the path rule), then anything the credential scanner recognises
 * (sync-redact.ts). The queue on disk holds only what passed both.
 *
 * Failure never blocks a session: all of it runs forked in the instance scope, errors are logged,
 * and a failed upload stays queued for a retry with backoff.
 */

export const LIMIT = 4 * 1024 * 1024
export const TRUNCATED = "…[truncated for sync]"
const DEBOUNCE = "2 seconds"
const QUOTA_MESSAGE =
  "Session sync paused: your Lunos space is full. Free space at https://app.lunos.tech/settings/usage, then run lunos sync on."
/** What a chunk the server refused as too large (413) becomes, so its seq still arrives. */
const EMPTY = JSON.stringify({ messages: [] })

export type SyncConfig = {
  sync?: ConfigSync.Info
  $locked?: readonly string[]
  residency?: Residency.ConfigBlock
  audit?: Parameters<typeof AuditLog.resolve>[0]["audit"]
}
export type Gate = "offline" | "signed-out" | "policy" | "device" | "directory"
export type Chunk = { seq: number; body: string; ids: string[] }

export function gates(input: {
  config: { sync?: ConfigSync.Info; $locked?: readonly string[] }
  state?: CloudSyncApi.State
  offline: boolean
}): { allowed: true } | { allowed: false; gate: Gate } {
  if (input.offline) return { allowed: false, gate: "offline" }
  if (!input.state) return { allowed: false, gate: "signed-out" }
  const off = input.config.sync === false
  if (off && ConfigPolicy.isLocked(input.config.$locked, "sync")) return { allowed: false, gate: "policy" }
  if (input.state.device.syncEnabled === false || input.state.paused === "quota")
    return { allowed: false, gate: "device" }
  if (off) return { allowed: false, gate: "directory" }
  return { allowed: true }
}

/**
 * The residency gate for `sync:lunos-cloud` at `endpoint`. Allowed when no residency policy is set.
 * A refusal is audited when `audit.audit` is set (the worker does it once per session; `lunos sync
 * status` asks without auditing): one `sync.denied` line with `gate: "residency"` and the egress
 * record's fields (target, region, basis, host).
 */
export function residency(
  config: SyncConfig,
  endpoint: string,
  audit: { audit?: boolean; session?: string } = {},
): { allowed: boolean; reason?: string } {
  if (!config.residency) return { allowed: true }
  const resolved = AuditLog.residency(config)
  if (!resolved) return { allowed: true }
  const target = Jurisdiction.SYNC_LUNOS_CLOUD
  const decision = Residency.evaluate(target, resolved.policy, endpoint)
  if (decision.allowed || resolved.enforce === false) return { allowed: true }
  if (audit.audit && resolved.audit) {
    const { claim } = Jurisdiction.resolve(target, endpoint, resolved.policy.endpoints)
    void Audit.write({ file: resolved.auditPath ?? AuditLog.DEFAULT_FILE() }, "sync.denied", {
      ...Residency.record(target, endpoint, false, new Date(), claim),
      gate: "residency",
      ...(audit.session ? { session: audit.session } : {}),
    })
  }
  return { allowed: false, reason: decision.reason }
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

function complete(m: SessionV1.WithParts) {
  const info = m.info as { role: string; time: { completed?: number } }
  return info.role === "user" || (info.role === "assistant" && info.time.completed !== undefined)
}

/**
 * The session record as it may leave the machine: no local `directory`, no revert patch or
 * snapshot hash (local undo state, and the patch can hold any file's content), `summary.diffs`
 * through the path rule, then every string through the scanner.
 */
function sessionInfo(info: Session.Info, isSecret: (p: string) => boolean) {
  const { directory: _, revert, ...rest } = structuredClone(info)
  const out: Record<string, unknown> = rest
  if (revert) out.revert = { messageID: revert.messageID, ...(revert.partID ? { partID: revert.partID } : {}) }
  return CloudSyncRedact.scan(CloudSyncRedact.message({ info: out, parts: [] }, isSecret).info)
}

/** Every string in `value`, each with a way to replace it. */
function strings(value: unknown, out: Array<{ get: () => string; set: (s: string) => void }>) {
  if (Array.isArray(value)) value.forEach((v, i) => visit(value, i, v, out))
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) visit(value as any, k, v, out)
  return out
}
function visit(
  owner: any,
  key: string | number,
  v: unknown,
  out: Array<{ get: () => string; set: (s: string) => void }>,
) {
  if (typeof v === "string") out.push({ get: () => owner[key], set: (s) => (owner[key] = s) })
  else strings(v, out)
}

/** Shrinks one redacted message to `budget` bytes: its largest tool outputs first, then any string. */
function fit<M extends { parts: any[] }>(m: M, budget: number): M {
  let size = bytes(m)
  if (size <= budget) return m
  const copy = structuredClone(m)
  const outputs = copy.parts.flatMap((p: any) =>
    p?.type === "tool" && typeof p.state?.output === "string"
      ? [{ get: () => p.state.output as string, set: (s: string) => (p.state.output = s) }]
      : [],
  )
  const everything = strings(copy.parts, [])
  for (const pool of [outputs, everything]) {
    while (size > budget) {
      const target = pool
        .filter((t) => t.get().length > TRUNCATED.length)
        .sort((a, b) => b.get().length - a.get().length)[0]
      if (!target) break
      const value = target.get()
      // Characters, not bytes: each removed character is at least one byte of the body, so this converges.
      target.set(value.slice(0, Math.max(0, value.length - (size - budget) - TRUNCATED.length - 16)) + TRUNCATED)
      size = bytes(copy)
    }
  }
  return copy
}

/**
 * The chunks one turn adds: the complete messages not yet in `cursor.sent`, redacted, packed in
 * order into bodies of at most 4 MiB (`meta` and `info` ride in the first). A message too big for a
 * body of its own has its tool outputs cut, marked `…[truncated for sync]`.
 */
export function build(
  session: Session.Info,
  messages: SessionV1.WithParts[],
  cursor: CloudSyncQueue.Cursor | undefined,
  opts: {
    directory: string
    exclude: readonly string[]
    project?: string
    repo?: { url?: string; commit?: string }
    model?: string
  },
): Chunk[] {
  const sent = new Set(cursor?.sent ?? [])
  const fresh = messages.filter((m) => !sent.has(m.info.id) && complete(m))
  if (!fresh.length) return []
  const isSecret = CloudSyncRedact.matcher(opts.directory, opts.exclude)
  const redacted = fresh.map((m) => CloudSyncRedact.scan(CloudSyncRedact.message(m, isSecret)))
  const meta = CloudSyncRedact.scan(
    Object.fromEntries(
      Object.entries({
        title: session.title,
        repoUrl: opts.repo?.url,
        repoCommit: opts.repo?.commit,
        model: opts.model,
        projectId: opts.project,
      }).filter(([, v]) => v !== undefined),
    ),
  )
  let info = sessionInfo(session, isSecret) as any
  // A session whose summary diffs alone would crowd out the messages keeps their names and counts only.
  if (bytes({ meta, info }) > LIMIT / 4 && Array.isArray(info.summary?.diffs))
    info = { ...info, summary: { ...info.summary, diffs: info.summary.diffs.map(({ patch: _, ...d }: any) => d) } }

  const head = bytes({ meta, info, messages: [] })
  const plain = bytes({ messages: [] })
  const out: Chunk[] = []
  let seq = cursor?.seq ?? 0
  let group: any[] = []
  let size = 0
  const close = () => {
    if (!group.length) return
    const body = JSON.stringify(out.length ? { messages: group } : { meta, info, messages: group })
    out.push({ seq: ++seq, body, ids: group.map((m) => m.info.id) })
    group = []
  }
  for (const m of redacted) {
    let n = bytes(m)
    // `size` counts the body so far: its envelope, the messages and the commas between them.
    if (group.length && size + 1 + n > LIMIT) close()
    const base = out.length ? plain : head
    const msg = !group.length && base + n > LIMIT ? fit(m, LIMIT - base) : m
    if (msg !== m) n = bytes(msg)
    size = group.length ? size + 1 + n : base + n
    group.push(msg)
  }
  close()
  return out
}

function model(source: Source) {
  for (let i = source.messages.length - 1; i >= 0; i--) {
    const info = source.messages[i]!.info as any
    if (info.role === "assistant" && info.providerID && info.modelID) return `${info.providerID}/${info.modelID}`
    if (info.role === "user" && info.model?.providerID) return `${info.model.providerID}/${info.model.modelID}`
  }
  const m = source.info.model
  return m ? `${m.providerID}/${m.id}` : undefined
}

async function git(directory: string, args: string[]) {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const out = (await new Response(proc.stdout).text()).trim()
    return (await proc.exited) === 0 && out ? out : undefined
  } catch {
    return undefined
  }
}

/** Remote URL (without any user name or token in it) and commit, best effort. */
async function repo(directory: string) {
  const url = await git(directory, ["remote", "get-url", "origin"])
  const commit = await git(directory, ["rev-parse", "HEAD"])
  return { url: url ? CloudWorkers.publicRemote(url).url : undefined, commit }
}

export type Source = { info: Session.Info; messages: SessionV1.WithParts[] }
export type Flushed = { retryIn?: number }
export type WorkerInput = {
  directory: string
  config: () => Promise<SyncConfig>
  load: (session: string) => Promise<Source | undefined>
  /** Tests inject `fetch`, `token`, `sub`; without `token` the stored Lunos Cloud session is used. */
  opts?: CloudSyncApi.Options
  log?: (level: "warn" | "error", message: string, fields?: Record<string, unknown>) => void
}
type Outcome = "done" | "next" | "stop" | "retry" | "rebuild"

/**
 * The sync loop without the Effect service around it: `turn` gates, builds and queues a session's
 * new messages, then uploads; `flush` uploads what is queued for this directory. Calls run one at
 * a time. Neither throws for a sync failure; `retryIn` asks the caller to flush again later.
 */
export function worker(input: WorkerInput) {
  const log = input.log ?? (() => {})
  const denied = new Set<string>()
  let attempt = 0
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>) => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  function deny(session: string, gate: string, fields: Record<string, unknown> = {}) {
    const key = `${session}:${gate}`
    if (denied.has(key)) return
    denied.add(key)
    AuditLog.emit("sync.denied", { session, gate, ...fields })
  }

  async function admit(session: string, state: CloudSyncApi.State | undefined, config: SyncConfig) {
    const g = gates({ config, state, offline: Offline.enabled() })
    if (!g.allowed) {
      if (g.gate !== "offline" && g.gate !== "signed-out") deny(session, g.gate)
      return false
    }
    const key = `${session}:residency`
    const r = residency(config, state!.endpoint, { audit: !denied.has(key), session })
    if (r.allowed) return true
    denied.add(key)
    return false
  }

  /** Who uploads: the injected token, or the stored session (refreshed if it is about to expire). */
  async function authorize(state: CloudSyncApi.State): Promise<CloudSyncApi.Options | "signed-out" | "network"> {
    if (input.opts?.token) return input.opts
    try {
      const s = await CloudAuth.session("Session sync")
      // device.json belongs to whoever signed in last; another user's sign-in re-registers at login.
      if (s.sub !== state.sub) return "signed-out"
      const token = s.tokens.access_token
      return { ...input.opts, token: async () => token, sub: s.sub }
    } catch (error) {
      if (error instanceof CloudAuth.SignedOutError) return "signed-out"
      log("warn", "session sync couldn't refresh the Lunos Cloud sign-in", { error: String(error) })
      return "network"
    }
  }

  /** Re-reads device.json and saves `fn` of it, so a `lunos sync on|off` in between isn't undone. */
  async function update(state: CloudSyncApi.State, fn: (s: CloudSyncApi.State) => CloudSyncApi.State) {
    const fresh = (await CloudSyncApi.load()) ?? state
    if (fresh.device.id !== state.device.id) return
    await CloudSyncApi.save(fn(fresh))
  }

  async function enqueue(session: string, config: SyncConfig, cursor: CloudSyncQueue.Cursor | undefined) {
    const source = await input.load(session)
    if (!source) return
    const options = config.sync || undefined
    const chunks = build(source.info, source.messages, cursor, {
      directory: input.directory,
      exclude: options?.exclude ?? [],
      project: options?.project,
      repo: await repo(input.directory),
      model: model(source),
    })
    for (const c of chunks) await CloudSyncQueue.enqueue(session, input.directory, c.seq, c.body, c.ids)
  }

  async function send(
    session: string,
    state: CloudSyncApi.State,
    auth: { opts: CloudSyncApi.Options; synced: boolean },
  ): Promise<Outcome> {
    let chunks = await CloudSyncQueue.pending(session)
    let resyncs = 0
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      let r = await CloudSyncApi.upload(state, session, chunk.seq, chunk.body, auth.opts)
      if (!r.ok && r.status === 401) {
        // Refresh once and retry once; still refused means signed out.
        const again = await authorize(state)
        if (typeof again !== "object") return "stop"
        auth.opts = again
        r = await CloudSyncApi.upload(state, session, chunk.seq, chunk.body, auth.opts)
        if (!r.ok && r.status === 401) return "stop"
      }
      if (r.ok) {
        await CloudSyncQueue.ack(session, chunk.seq)
        AuditLog.emit("sync.upload", {
          session,
          device: state.device.id,
          seq: chunk.seq,
          bytes: Buffer.byteLength(chunk.body),
          endpoint: state.endpoint,
        })
        attempt = 0
        auth.synced = true
        continue
      }
      if (r.status === 409 && r.code === "out_of_order") {
        // The server's answer carries no position: ask for it (never parse the message).
        const st = await CloudSyncApi.status(state, session, auth.opts)
        if (!st.ok) {
          if (st.status === 410) {
            await CloudSyncQueue.drop(session, "deleted")
            return "next"
          }
          return "retry"
        }
        if (st.deleted) {
          await CloudSyncQueue.drop(session, "deleted")
          return "next"
        }
        await CloudSyncQueue.ack(session, st.lastSeq)
        const rest = await CloudSyncQueue.pending(session)
        if (rest[0]?.seq === st.lastSeq + 1 && resyncs++ < 2) {
          chunks = rest
          i = -1
          continue
        }
        // The server needs a seq no longer queued (it lost data, or the queue did): start over from
        // its position. The rebuilt chunks hold every message again; the server dedupes them.
        await CloudSyncQueue.ack(session, Number.MAX_SAFE_INTEGER)
        const cursor = await CloudSyncQueue.cursor(session)
        await CloudSyncQueue.writeCursor({ session, directory: input.directory, ...cursor, seq: st.lastSeq, sent: [] })
        return "rebuild"
      }
      if (r.status === 409 && r.code === "chunk_conflict") {
        log("warn", "session sync: the server already holds a different chunk at this seq; keeping its copy", {
          session,
          seq: chunk.seq,
        })
        await CloudSyncQueue.ack(session, chunk.seq)
        continue
      }
      if (r.status === 409 && r.code === "sync_disabled") {
        await update(state, (s) => ({ ...s, device: { ...s.device, syncEnabled: false } }))
        deny(session, "device")
        return "stop"
      }
      if (r.status === 403 && r.code === "device_revoked") {
        await fs.rm(CloudSyncApi.file(), { force: true })
        log(
          "warn",
          "session sync stopped: this device was removed from your Lunos space. Run lunos login to add it again.",
        )
        return "stop"
      }
      if (r.status === 410) {
        await CloudSyncQueue.drop(session, "deleted")
        return "next"
      }
      if (r.status === 403 || (r.status === 409 && r.code === "project_archived")) {
        await CloudSyncQueue.drop(session, "denied")
        deny(session, "server", { code: r.code })
        return "next"
      }
      if (r.status === 507) {
        await update(state, (s) => ({ ...s, paused: "quota" }))
        log("warn", QUOTA_MESSAGE)
        return "stop"
      }
      if (r.status === 413) {
        // Too big even after splitting. Its messages are lost to the space, but its seq is filled
        // with an empty chunk: a gap would make every later chunk out_of_order, and the rebuild
        // that follows would hit the same 413 again.
        log("warn", "session sync: the server refused a chunk as too large; it is skipped", { session, seq: chunk.seq })
        if (chunk.body === EMPTY) {
          await CloudSyncQueue.ack(session, chunk.seq)
          continue
        }
        // The queue never overwrites a seq with other content, so the refused chunk goes first.
        await CloudSyncQueue.ack(session, chunk.seq)
        await CloudSyncQueue.enqueue(session, input.directory, chunk.seq, EMPTY, [])
        chunks[i] = { ...chunk, body: EMPTY }
        i--
        continue
      }
      log("warn", "session sync upload failed; will retry", { session, seq: chunk.seq, status: r.status, code: r.code })
      return "retry"
    }
    return "done"
  }

  async function drain(): Promise<Flushed> {
    if (Offline.enabled()) return {}
    const state = await CloudSyncApi.load()
    if (!state) return {}
    const config = await input.config()
    const sessions = [...new Set((await CloudSyncQueue.pending()).map((c) => c.session))]
    const mine: string[] = []
    for (const s of sessions) {
      const cursor = await CloudSyncQueue.cursor(s)
      if (cursor?.directory === input.directory && !cursor.stopped) mine.push(s)
    }
    if (!mine.length) return {}
    const opts = await authorize(state)
    if (opts === "signed-out") return {}
    if (opts === "network") return { retryIn: CloudSyncQueue.backoff(++attempt) }
    const auth = { opts, synced: false }
    try {
      for (const session of mine) {
        if (!(await admit(session, state, config))) continue
        let outcome = await send(session, state, auth)
        if (outcome === "rebuild") {
          await enqueue(session, config, await CloudSyncQueue.cursor(session))
          outcome = await send(session, state, auth)
          if (outcome === "rebuild") outcome = "next"
        }
        if (outcome === "stop") return {}
        if (outcome === "retry") return { retryIn: CloudSyncQueue.backoff(++attempt) }
      }
      return {}
    } finally {
      if (auth.synced)
        await update(state, (s) => ({ ...s, device: { ...s.device, lastSyncAt: Date.now() } })).catch(() => {})
    }
  }

  async function turn(session: string): Promise<Flushed> {
    if (Offline.enabled()) return {}
    const state = await CloudSyncApi.load()
    if (state && !input.opts?.token && !(await CloudStore.load())) return {}
    const config = await input.config()
    if (!(await admit(session, state, config))) return {}
    const cursor = await CloudSyncQueue.cursor(session)
    if (cursor?.stopped) return {}
    await enqueue(session, config, cursor)
    return drain()
  }

  return {
    turn: (session: string) => serial(() => turn(session)),
    flush: () => serial(drain),
  }
}
export type Worker = ReturnType<typeof worker>

export interface Interface {
  readonly init: () => Effect.Effect<void>
  /** Uploads what is queued now (tests; `lunos sync status` does its own). */
  readonly flush: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CloudSync") {}

type State = {
  scope: Scope.Closeable
  worker: Worker
  pending: Map<SessionID, Fiber.Fiber<unknown, unknown>>
  retry?: Fiber.Fiber<unknown, unknown>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const session = yield* Session.Service

    const run = (s: State, fn: (w: Worker) => Promise<Flushed>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => fn(s.worker))
        if (result.retryIn === undefined || s.retry) return
        s.retry = yield* Effect.sleep(result.retryIn).pipe(
          Effect.andThen(Effect.sync(() => (s.retry = undefined))),
          Effect.andThen(Effect.suspend(() => run(s, (w) => w.flush()))),
          Effect.forkIn(s.scope),
        )
      }).pipe(Effect.catchCause((cause) => Effect.logError("session sync failed", { cause })))

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("CloudSync.state")(function* (ctx) {
        const bridge = yield* EffectBridge.make()
        const cache: State = {
          scope: yield* Scope.make(),
          pending: new Map(),
          worker: worker({
            directory: ctx.directory,
            config: () => bridge.promise(cfg.get()) as Promise<SyncConfig>,
            load: (id) =>
              bridge.promise(
                Effect.all({
                  info: session.get(id as SessionID),
                  messages: session.messages({ sessionID: id as SessionID }),
                }).pipe(Effect.catch(() => Effect.succeed(undefined))),
              ),
            log: (level, message, fields) =>
              void bridge.fork(
                level === "warn" ? Effect.logWarning(message, fields ?? {}) : Effect.logError(message, fields ?? {}),
              ),
          }),
        }
        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(Effect.andThen(Effect.sync(() => cache.pending.clear()))),
        )

        // A turn is over when its session goes idle; a burst of them uploads once, 2 s after the last.
        yield* events.listen((event) => {
          if (event.type !== SessionStatus.Event.Status.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof SessionStatus.Event.Status>
          if (data.status.type !== "idle") return Effect.void
          return Effect.gen(function* () {
            const previous = cache.pending.get(data.sessionID)
            if (previous) yield* Fiber.interrupt(previous)
            const fiber = yield* Effect.sleep(DEBOUNCE).pipe(
              Effect.andThen(Effect.sync(() => cache.pending.delete(data.sessionID))),
              Effect.andThen(run(cache, (w) => w.turn(data.sessionID))),
              Effect.forkIn(cache.scope),
            )
            cache.pending.set(data.sessionID, fiber)
          }).pipe(Effect.catchCause((cause) => Effect.logError("session sync subscriber failed", { cause })))
        })

        // A restarted server resumes what is still queued.
        yield* run(cache, (w) => w.flush()).pipe(Effect.forkIn(cache.scope))
        return cache
      }),
    )

    const init = Effect.fn("CloudSync.init")(function* () {
      yield* InstanceState.get(state)
    })

    const flush = Effect.fn("CloudSync.flush")(function* () {
      const s = yield* InstanceState.get(state)
      yield* run(s, (w) => w.flush())
    })

    return Service.of({ init, flush })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, Session.node],
})
