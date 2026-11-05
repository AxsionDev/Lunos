export * as CloudRemote from "./remote"

import { Offline } from "@opencode-ai/core/offline"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AuditLog } from "@/audit/log"
import { ConfigPolicy } from "@/config/policy"
import { CloudAuth } from "./auth"
import { CloudRemoteLink } from "./remote-link"
import { CloudStore } from "./store"
import { CloudSync, type SyncConfig } from "./sync"
import { CloudSyncApi } from "./sync-api"
import { CloudSyncRedact } from "./sync-redact"

/**
 * XCOD-338: remote control. `/remote on` makes one session available at app.lunos.tech to the
 * signed-in account that owns it: the user follows the live transcript, answers its approvals and
 * questions, sends or queues prompts and stops it, from a phone or another computer. The session
 * still runs here, with this process's agent, policy and residency; nothing reaches the machine
 * from outside except through the one outgoing connection to Lunos Cloud (CloudRemoteLink): no
 * port is opened.
 *
 * Gates when it is turned on, in order: offline → the organisation's policy (`remote_control: false`
 * or `sync: false`, locked) → this directory's `remote_control: false` or `sync: false` → signed out, or a
 * sign-in sync may not use → this device not registered, or its sync switched off in the app →
 * the residency policy. Each refusal says why and is audited (`remote.denied`) except offline.
 *
 * What leaves the machine follows the session sync rules (XCOD-185): never-upload files and
 * `sync.exclude` through the path rule, then every string through the credential scanner, on
 * whole parts (streamed text is accumulated here and sent as snapshots, so a secret split across
 * two deltas is still caught). Permission requests go with their kind and patterns only. Both the
 * V1 asks (`/permission`, `/question`) and the V2 session core's (`permission.v2.*`, `question.v2.*`,
 * answered through `/api/session/:id/permission|question/...`) are forwarded, in the same shape, so
 * the web doesn't tell them apart; an answer goes to whichever list holds the request.
 *
 * Every command from the web is checked again here before it runs: the link must still be on (a
 * poll in flight can outlive `/remote off`), a permission or question must be pending for this
 * session or one of its subagents, and a command older than COMMAND_TTL_MS is dropped. A remote
 * approval goes through this process's own permission route and is audited there as
 * `permission.decision` with `via: "remote"`; every command is audited as `remote.command`.
 *
 * It ends at once on `/remote off`, when the session is deleted or its project closes, when the
 * link is revoked on the web (the next poll answers 410), and after 12 hours.
 */

export const MAX_HOURS = 12
export const COMMAND_TTL_MS = 60_000
export const STOP_REASON = "Stopped remotely"
/** How often streamed changes are sent, at most. */
const FLUSH_MS = 300
/** Under the control plane's 256 KiB request limit, with room for the envelope. */
const MAX_BATCH_BYTES = 200 * 1024
/** One part's text or output is cut to this before it is sent (the full transcript syncs separately). */
const MAX_FIELD = 32 * 1024
const SNAPSHOT_MESSAGES = 40

export type Gate = "offline" | "policy" | "directory" | "signed-out" | "not-registered" | "device" | "residency"
export type RemoteConfig = SyncConfig & { remote_control?: boolean }

export type Status =
  | { on: false; reason?: string }
  | { on: true; link: string; url: string; expiresAt: number; endpoint: string }

export class RemoteError extends Error {
  constructor(
    readonly gate: Gate | "relay",
    message: string,
  ) {
    super(message)
  }
}

const MESSAGES: Record<Gate, string> = {
  offline: "Remote control needs Lunos Cloud, and Lunos is offline (LUNOS_OFFLINE).",
  policy: "Your organisation's policy keeps remote control off.",
  directory: "Remote control is off for this directory (remote_control: false or sync: false in its config).",
  "signed-out": "Sign in to Lunos first (lunos login): remote control works through your Lunos account.",
  "not-registered": "This computer isn't registered with your Lunos space. Run lunos sync on (or lunos login).",
  device: "Session sync is off for this computer, so remote control is too. Turn sync on in app.lunos.tech, Devices.",
  residency: "Your residency policy doesn't allow Lunos Cloud, so remote control is off.",
}

/** Which gate, if any, keeps remote control off. Pure. */
export function gate(input: {
  config: RemoteConfig
  offline: boolean
  signedIn: boolean
  state?: CloudSyncApi.State
}): Gate | undefined {
  if (input.offline) return "offline"
  const locked = (key: string) => ConfigPolicy.isLocked(input.config.$locked, key)
  if (
    (input.config.remote_control === false && locked("remote_control")) ||
    (input.config.sync === false && locked("sync"))
  )
    return "policy"
  if (input.config.remote_control === false || input.config.sync === false) return "directory"
  if (!input.signedIn) return "signed-out"
  if (!input.state) return "not-registered"
  if (!input.state.device.syncEnabled || input.state.device.revokedAt) return "device"
  return undefined
}

/** The process's own HTTP API (SessionPeerControl.api), bound to the session's directory. */
export type Api = (path: string, init?: RequestInit) => Promise<Response>

export type BridgeInput = {
  sessionID: string
  directory: string
  link: CloudRemoteLink.Link
  opts: CloudRemoteLink.Options
  exclude: readonly string[]
  api: Api
  /** A prompt for this session (SessionPromptQueue.submit with via "remote"). */
  submit: (text: string, interrupt: boolean) => Promise<{ delivery: string }>
  /** Stops the session: rejects its asks, then aborts the turn (SessionPeerControl.stopSession). */
  stop: () => Promise<void>
  /** Tells the permission service the next answer to `requestID` came from the web (audit `via`). */
  mark: (requestID: string) => void
  subscribe: (listener: (event: GlobalEvent) => void) => () => void
  /** Called once, when the bridge ends for any reason other than `close()`. */
  ended: (reason: string) => void
  now?: () => number
  log?: (message: string, fields?: Record<string, unknown>) => void
}

type Part = Record<string, any> & { id: string; messageID: string; sessionID: string; type: string }

/**
 * One session's bridge to its link: forwards the session's events and runs the commands it
 * collects. Returns `close`, which stops both at once (the link is closed by the caller).
 */
export function bridge(input: BridgeInput) {
  const now = input.now ?? Date.now
  const log = input.log ?? (() => {})
  const isSecret = CloudSyncRedact.matcher(input.directory, input.exclude)
  const children = new Set<string>()
  const parts = new Map<string, Map<string, Part>>()
  const pending = new Map<string, CloudRemoteLink.Event>()
  let open = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> = Promise.resolve()

  const own = (sessionID: unknown) =>
    typeof sessionID === "string" && (sessionID === input.sessionID || children.has(sessionID))

  function queue(events: CloudRemoteLink.Event[]) {
    if (!open) return
    for (const e of events) pending.set(e.key ?? `${Math.random()}`, e)
    if (!timer) {
      timer = setTimeout(() => {
        timer = undefined
        flushing = flushing.then(flush)
      }, FLUSH_MS)
      timer.unref?.()
    }
  }

  async function flush() {
    if (!open || !pending.size) return
    const all = [...pending.values()]
    pending.clear()
    // Batches under the request limit; one event too big on its own was already cut by `clip`.
    let batch: CloudRemoteLink.Event[] = []
    let size = 0
    const send = async () => {
      if (!batch.length) return
      const out = batch
      batch = []
      size = 0
      await CloudRemoteLink.push(input.opts, input.link, out)
    }
    try {
      for (const e of all) {
        const n = JSON.stringify(e).length
        if (size + n > MAX_BATCH_BYTES) await send()
        batch.push(e)
        size += n
      }
      await send()
    } catch (error) {
      if (error instanceof CloudRemoteLink.LinkEndedError) return end(error.reason ?? "revoked")
      log("remote control: couldn't send the session's events", { error: String(error) })
    }
  }

  /** A part as it may leave the machine: the path rule over its message's parts, then the scanner. */
  function redactPart(part: Part) {
    const siblings = parts.get(part.messageID) ?? new Map<string, Part>()
    siblings.set(part.id, part)
    parts.set(part.messageID, siblings)
    const list = [...siblings.values()].sort((a, b) => a.id.localeCompare(b.id))
    const redacted = CloudSyncRedact.message({ info: {}, parts: list }, isSecret).parts.find(
      (p: Part) => p.id === part.id,
    )
    return CloudSyncRedact.scan(clip(redacted ?? part))
  }

  function translate(event: GlobalEvent): CloudRemoteLink.Event[] {
    const payload = event.payload
    if (!payload || typeof payload !== "object") return []
    const p = (payload.properties ?? {}) as Record<string, any>
    switch (payload.type) {
      case "session.created":
      case "session.updated": {
        const info = p.info ?? {}
        if (info.parentID && own(info.parentID)) children.add(info.id)
        if (!own(info.id)) return []
        return [
          {
            type: "session",
            key: `session:${info.id}`,
            data: CloudSyncRedact.scan({ id: info.id, title: info.title, parentID: info.parentID }),
          },
        ]
      }
      case "message.updated": {
        const info = p.info ?? {}
        if (!own(info.sessionID)) return []
        const out: CloudRemoteLink.Event[] = [
          {
            type: "message",
            key: `message:${info.id}`,
            data: { id: info.id, sessionID: info.sessionID, role: info.role, time: info.time },
          },
        ]
        if (info.role === "assistant" && info.sessionID === input.sessionID)
          out.push({
            type: "statusline",
            key: "statusline",
            data: {
              agent: info.agent ?? info.mode,
              model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined,
              tokens: tokens(info.tokens),
              cost: typeof info.cost === "number" ? info.cost : undefined,
            },
          })
        return out
      }
      case "message.part.updated": {
        const part = p.part as Part | undefined
        if (!part || !own(part.sessionID)) return []
        return [{ type: "part", key: `part:${part.id}`, data: redactPart(part) }]
      }
      case "message.part.delta": {
        if (!own(p.sessionID) || typeof p.field !== "string" || typeof p.delta !== "string") return []
        const part = parts.get(p.messageID)?.get(p.partID)
        if (!part) return []
        const next = { ...part, [p.field]: String(part[p.field] ?? "") + p.delta }
        return [{ type: "part", key: `part:${part.id}`, data: redactPart(next) }]
      }
      case "session.status":
        if (!own(p.sessionID)) return []
        return [
          {
            type: "status",
            key: `status:${p.sessionID}`,
            data: {
              sessionID: p.sessionID,
              type: p.status?.type ?? "idle",
              message: p.status?.message ? CloudSyncRedact.scan(String(p.status.message)) : undefined,
            },
          },
        ]
      case "permission.asked":
      case "permission.v2.asked":
        if (!own(p.sessionID)) return []
        return [
          {
            type: "permission.asked",
            key: `ask:${p.id}`,
            data: CloudSyncRedact.scan({
              id: p.id,
              sessionID: p.sessionID,
              permission: p.permission ?? p.action,
              // V2 asks name their action and resources; V1 asks, their permission and patterns.
              patterns: (Array.isArray(p.patterns) ? p.patterns : Array.isArray(p.resources) ? p.resources : []).map(
                (x: unknown) => (isSecret(String(x)) ? `[not synced: ${x}]` : String(x)),
              ),
            }),
          },
        ]
      case "question.asked":
      case "question.v2.asked":
        if (!own(p.sessionID)) return []
        return [
          {
            type: "question.asked",
            key: `ask:${p.id}`,
            data: CloudSyncRedact.scan({ id: p.id, sessionID: p.sessionID, questions: p.questions }),
          },
        ]
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
      case "permission.v2.replied":
      case "question.v2.replied":
      case "question.v2.rejected":
        if (!own(p.sessionID)) return []
        return [
          {
            type: "ask.settled",
            key: `ask:${p.requestID}`,
            data: { id: p.requestID, sessionID: p.sessionID, reply: p.reply },
          },
        ]
      case "todo.updated":
        if (p.sessionID !== input.sessionID) return []
        return [
          {
            type: "todo",
            key: `todo:${p.sessionID}`,
            data: CloudSyncRedact.scan({ sessionID: p.sessionID, todos: p.todos }),
          },
        ]
      case "session.deleted":
        if (p.sessionID === input.sessionID || p.info?.id === input.sessionID) end("ended")
        return []
      case "server.instance.disposed":
        if (p.directory === input.directory) end("ended")
        return []
    }
    return []
  }

  type Ask = { id?: string; sessionID?: string; action?: string; resources?: string[] }

  /**
   * Where a request waits, if it waits for this session or one of its subagents: the V1 list first,
   * then the V2 session core's (its list is `{ location, data }`, for the directory's location). The
   * two use the same id prefixes, so the lists decide, never the id.
   */
  async function pendingFor(
    kind: "permission" | "question",
    requestID: string,
  ): Promise<{ v2: boolean; ask: Ask } | undefined> {
    const v1 = await input.api(`/${kind}`)
    const list = v1.ok ? ((await v1.json().catch(() => [])) as Ask[]) : []
    const found = Array.isArray(list) ? list.find((item) => item.id === requestID && own(item.sessionID)) : undefined
    if (found) return { v2: false, ask: found }
    const v2 = await input.api(v2Path(`/api/${kind}/request`, input.directory))
    const body = v2.ok ? ((await v2.json().catch(() => undefined)) as { data?: Ask[] } | undefined) : undefined
    const ask = (Array.isArray(body?.data) ? body.data : []).find(
      (item) => item.id === requestID && own(item.sessionID),
    )
    return ask ? { v2: true, ask } : undefined
  }

  async function run(command: CloudRemoteLink.Command): Promise<{ ok: boolean; error?: string; delivery?: string }> {
    if (now() - command.at > COMMAND_TTL_MS) return { ok: false, error: "The command was too old to run." }
    switch (command.type) {
      case "prompt": {
        const r = await input.submit(command.text, !command.queue)
        return { ok: true, delivery: r.delivery }
      }
      case "permission": {
        const found = await pendingFor("permission", command.requestID)
        if (!found) return { ok: false, error: "No such approval is waiting in this session." }
        const body = JSON.stringify({ reply: command.reply, ...(command.message ? { message: command.message } : {}) })
        if (!found.v2) {
          input.mark(command.requestID)
          const res = await input.api(`/permission/${command.requestID}/reply`, { method: "POST", body })
          return res.ok ? { ok: true } : { ok: false, error: `The approval failed (${res.status}).` }
        }
        // The V2 core audits no decision of its own; a remote one is recorded here, as V1's is there.
        const res = await input.api(`/api/session/${found.ask.sessionID}/permission/${command.requestID}/reply`, {
          method: "POST",
          body,
        })
        if (!res.ok) return { ok: false, error: `The approval failed (${res.status}).` }
        AuditLog.emit("permission.decision", {
          session: found.ask.sessionID,
          permission: found.ask.action,
          patterns: found.ask.resources,
          decision:
            command.reply === "reject" ? "denied" : command.reply === "always" ? "allowed always" : "allowed once",
          via: "remote",
        })
        return { ok: true }
      }
      case "question": {
        const found = await pendingFor("question", command.requestID)
        if (!found) return { ok: false, error: "No such question is waiting in this session." }
        const base = found.v2
          ? `/api/session/${found.ask.sessionID}/question/${command.requestID}`
          : `/question/${command.requestID}`
        const res = command.reject
          ? await input.api(`${base}/reject`, { method: "POST", ...(found.v2 ? {} : { body: "null" }) })
          : await input.api(`${base}/reply`, {
              method: "POST",
              body: JSON.stringify({ answers: command.answers ?? [] }),
            })
        return res.ok ? { ok: true } : { ok: false, error: `The answer failed (${res.status}).` }
      }
      case "stop":
        await input.stop()
        return { ok: true }
      case "interrupt": {
        const res = await input.api(`/session/${input.sessionID}/abort`, { method: "POST" })
        return res.ok ? { ok: true } : { ok: false, error: `Interrupting failed (${res.status}).` }
      }
    }
    return { ok: false, error: "Unknown command." }
  }

  async function poll() {
    let failures = 0
    while (open) {
      let commands: CloudRemoteLink.Command[]
      try {
        commands = await CloudRemoteLink.collect(input.opts, input.link)
        failures = 0
      } catch (error) {
        if (error instanceof CloudRemoteLink.LinkEndedError) return end(error.reason ?? "revoked")
        if (
          error instanceof CloudRemoteLink.RelayError &&
          (error.status === 401 || error.status === 403 || error.status === 404)
        )
          return end("refused")
        failures++
        log("remote control: the relay didn't answer; retrying", { error: String(error) })
        await Bun.sleep(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)))
        continue
      }
      for (const command of commands) {
        // `/remote off` may have come while this poll was in flight: nothing it brought runs.
        if (!open) return
        const result = await run(command).catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
        AuditLog.emit("remote.command", {
          session: input.sessionID,
          link: input.link.id,
          command: command.id,
          kind: command.type,
          via: "remote",
          ok: result.ok,
          ...(command.type === "permission" ? { request: command.requestID, reply: command.reply } : {}),
          ...(command.type === "question" ? { request: command.requestID } : {}),
        })
        queue([{ type: "command.result", data: { command: command.id, kind: command.type, ...result } }])
      }
    }
  }

  function end(reason: string) {
    if (!open) return
    close()
    input.ended(reason)
  }

  const unsubscribe = input.subscribe((event) => {
    if (!open) return
    const events = translate(event)
    if (events.length) queue(events)
  })
  const expiry = setTimeout(() => end("expired"), Math.max(0, input.link.expiresAt - now()))
  expiry.unref?.()
  const polling = poll()

  function close() {
    if (!open) return
    open = false
    unsubscribe()
    clearTimeout(expiry)
    if (timer) clearTimeout(timer)
    pending.clear()
  }

  return {
    close,
    get open() {
      return open
    },
    /** What the web sees first: the session, its recent messages and what it is waiting on. */
    snapshot: async () => {
      const [session, messages, permissions, questions, permissionsV2, questionsV2] = await Promise.all(
        [
          `/session/${input.sessionID}`,
          `/session/${input.sessionID}/message?limit=${SNAPSHOT_MESSAGES}`,
          "/permission",
          "/question",
          v2Path("/api/permission/request", input.directory),
          v2Path("/api/question/request", input.directory),
        ].map((path) =>
          input
            .api(path)
            .then((r) => (r.ok ? r.json() : undefined))
            .catch(() => undefined),
        ),
      )
      const out: GlobalEvent[] = []
      if (session)
        out.push({ payload: { type: "session.updated", properties: { sessionID: input.sessionID, info: session } } })
      for (const m of Array.isArray(messages) ? messages : []) {
        out.push({ payload: { type: "message.updated", properties: { sessionID: input.sessionID, info: m.info } } })
        for (const part of m.parts ?? [])
          out.push({ payload: { type: "message.part.updated", properties: { sessionID: input.sessionID, part } } })
      }
      for (const ask of Array.isArray(permissions) ? permissions : [])
        out.push({ payload: { type: "permission.asked", properties: ask } })
      for (const ask of Array.isArray(questions) ? questions : [])
        out.push({ payload: { type: "question.asked", properties: ask } })
      for (const ask of Array.isArray(permissionsV2?.data) ? permissionsV2.data : [])
        out.push({ payload: { type: "permission.v2.asked", properties: ask } })
      for (const ask of Array.isArray(questionsV2?.data) ? questionsV2.data : [])
        out.push({ payload: { type: "question.v2.asked", properties: ask } })
      queue(out.flatMap(translate))
      await new Promise((resolve) => setTimeout(resolve, FLUSH_MS + 10))
      await flushing
    },
    flush: async () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
        flushing = flushing.then(flush)
      }
      await flushing
    },
    polling,
  }
}

/**
 * A V2 location route for the directory: those read `location[directory]`, not `directory` (which
 * they would ignore, falling back to the process's working directory).
 */
export function v2Path(path: string, directory: string) {
  return `${path}?${new URLSearchParams({ "location[directory]": directory })}`
}

function tokens(t: any) {
  if (!t || typeof t !== "object") return undefined
  const n = [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write].filter((v) => typeof v === "number")
  return n.length ? n.reduce((a: number, b: number) => a + b, 0) : undefined
}

/** Cuts a part's long strings (tool output, text) so one part can't fill the relay's buffer. */
function clip<T>(value: T): T {
  if (typeof value === "string")
    return (value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) + "…[cut for remote]" : value) as T
  if (Array.isArray(value)) return value.map(clip) as T
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)])) as T
  return value
}

// The process's remote sessions: one bridge per session, at most.
type Active = {
  bridge: ReturnType<typeof bridge>
  link: CloudRemoteLink.Link
  opts: CloudRemoteLink.Options
  directory: string
}
const active = new Map<string, Active>()

/** The link to app.lunos.tech for a session, as the user opens it. */
export function webUrl(link: string) {
  return `https://app.lunos.tech/remote/${link}`
}

export function status(sessionID: string): Status {
  const a = active.get(sessionID)
  if (!a) return { on: false }
  return { on: true, link: a.link.id, url: webUrl(a.link.id), expiresAt: a.link.expiresAt, endpoint: a.opts.endpoint }
}

/** Every session this process has remote, for the sidebar and tests. */
export function list() {
  return [...active.keys()]
}

export type EnableInput = {
  sessionID: string
  directory: string
  config: RemoteConfig
  title?: string
  /** The session's agent: remote prompts run with it, as the Agent Monitor's do. */
  agent?: string
  /** Tests: the relay, the token and the process's API; otherwise the stored sign-in and SessionPeerControl. */
  opts?: CloudRemoteLink.Options
  deps?: Partial<Pick<BridgeInput, "api" | "submit" | "stop" | "mark" | "subscribe">>
}

/** `/remote on`. Throws RemoteError with the gate that refused, already audited. */
export async function enable(input: EnableInput): Promise<Status> {
  const existing = status(input.sessionID)
  if (existing.on) return existing
  const state = await CloudSyncApi.load()
  const signedIn = input.opts ? true : await signedInForSync()
  const refused = gate({ config: input.config, offline: Offline.enabled(), signedIn, state })
  if (refused) throw deny(input.sessionID, refused)
  const endpoint = input.opts?.endpoint ?? state!.endpoint
  if (!CloudSync.residency(input.config, endpoint, { audit: true, session: input.sessionID }).allowed)
    throw deny(input.sessionID, "residency")
  const opts: CloudRemoteLink.Options = input.opts ?? {
    endpoint,
    token: async () => (await CloudAuth.session("Remote control")).tokens.access_token,
  }
  const device = state!.device.id
  const link = await CloudRemoteLink.open(opts, {
    device,
    session: input.sessionID,
    title: input.title ? CloudSyncRedact.scan(input.title).slice(0, 200) : undefined,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    AuditLog.emit("remote.denied", { session: input.sessionID, gate: "relay", reason: message })
    throw new RemoteError("relay", `Lunos Cloud refused remote control: ${message}`)
  })
  const deps = { ...(await defaultDeps(input.sessionID, input.directory, input.agent)), ...input.deps }
  const sync = input.config.sync || undefined
  const b = bridge({
    sessionID: input.sessionID,
    directory: input.directory,
    link,
    opts,
    exclude: sync?.exclude ?? [],
    ...deps,
    ended: (reason) => {
      active.delete(input.sessionID)
      void CloudRemoteLink.close(opts, link)
      AuditLog.emit("remote.off", { session: input.sessionID, link: link.id, reason })
    },
  })
  active.set(input.sessionID, { bridge: b, link, opts, directory: input.directory })
  AuditLog.emit("remote.on", {
    session: input.sessionID,
    link: link.id,
    device,
    endpoint,
    expires_at: new Date(link.expiresAt).toISOString(),
  })
  await b.snapshot().catch(() => undefined)
  return status(input.sessionID)
}

/** `/remote off`: the bridge stops before this returns, so nothing more from the web runs. */
export async function disable(sessionID: string, reason = "off") {
  const a = active.get(sessionID)
  if (!a) return { on: false } as Status
  active.delete(sessionID)
  a.bridge.close()
  AuditLog.emit("remote.off", { session: sessionID, link: a.link.id, reason })
  await CloudRemoteLink.close(a.opts, a.link)
  return { on: false } as Status
}

function deny(sessionID: string, g: Gate, audit = true) {
  if (audit && g !== "offline") AuditLog.emit("remote.denied", { session: sessionID, gate: g })
  return new RemoteError(g, MESSAGES[g])
}

async function signedInForSync() {
  const stored = await CloudStore.load()
  return !!stored && (await CloudSyncApi.permitted(stored.issuer))
}

async function defaultDeps(sessionID: string, directory: string, agent?: string) {
  const [{ SessionPeerControl }, { SessionPromptQueue }, { Permission }] = await Promise.all([
    import("@/session/peer-control"),
    import("@/session/prompt-queue"),
    import("@/permission"),
  ])
  return {
    api: (path: string, init?: RequestInit) => SessionPeerControl.api(path, directory, init),
    submit: (text: string, interrupt: boolean) =>
      SessionPromptQueue.submit({ sessionID, directory, text, interrupt, via: "remote", ...(agent ? { agent } : {}) }),
    stop: async () => {
      await SessionPeerControl.stopSession(sessionID, directory, STOP_REASON)
    },
    mark: (requestID: string) => Permission.markVia(requestID, "remote"),
    subscribe: (listener: (event: GlobalEvent) => void) => {
      GlobalBus.on("event", listener)
      return () => void GlobalBus.off("event", listener)
    },
  } satisfies Pick<BridgeInput, "api" | "submit" | "stop" | "mark" | "subscribe">
}
