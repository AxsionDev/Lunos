export * as ExternalSession from "./session"

import { ConfigExternal } from "@opencode-ai/core/config/external"
import { Cause, Effect, Exit } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { NamedError } from "@opencode-ai/core/util/error"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"
import type { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { Config } from "@/config/config"
import type { EventV2 } from "@opencode-ai/core/event"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ExternalDetect } from "./detect"
import { ExternalPolicy } from "./policy"
import { ExternalRegistry } from "./registry"
import { ExternalRun } from "./run"
import { ExternalClaude } from "./claude"
import { ExternalCodex } from "./codex"
import { ExternalBridge } from "./bridge"
import { ExternalBridgeTools } from "./bridge-tools"
import { ExternalConsent } from "./consent"
import { ExternalHooks } from "./hooks"
import type { MCP } from "@/mcp"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import type { Plugin } from "@/plugin"
import type { Memory } from "@/memory"
import type { Skill } from "@/skill"
import type { Question } from "@/question"
import type { EffectBridge as EffectBridgeType } from "@/effect/bridge"
import type { PermissionV1 as PermissionV1Type } from "@opencode-ai/core/v1/permission"

/**
 * XCOD-218: a Lunos session whose replies come from the user's own Claude Code or Codex CLI
 * instead of a Lunos model. It is an ordinary session (same list, history and storage) marked
 * with `metadata.external`; each prompt is one turn of the tool, resumed by the tool's own
 * session id, so the conversation survives a Lunos restart. The tool's events become the
 * assistant message's parts, its approvals go through Lunos's permission service
 * (`external` → `claude:<Tool> <target>`), and the cost it reports is the turn's cost.
 */

export const PROVIDER = "external"

export interface Marker {
  tool: ExternalDetect.Tool
  /** The tool's own session (Claude Code) or thread (Codex) id, once it has one. */
  session?: string
  /** The tool's own slash commands, as it reported them on its last start. */
  commands?: string[]
  /** XCOD-254: the tool's model chosen with /models, passed on every turn; unset uses the tool's default. */
  model?: string
  /** XCOD-254: "Not now" to sharing with the tool, for this session only (the next one asks again). */
  consent?: "later"
  /** XCOD-254: what the Lunos bridge offered on the last turn, for the header's status line. */
  bridge?: ExternalBridge.Status
}

export function of(info: { metadata?: Record<string, any> }): Marker | undefined {
  const value = info.metadata?.external
  if (!value || typeof value !== "object") return undefined
  if (value.tool !== "claude" && value.tool !== "codex") return undefined
  return value as Marker
}

export function label(tool: ExternalDetect.Tool) {
  return ExternalDetect.TOOLS[tool].label
}

/** The title an external session starts with; replaced by "<label> · <id>" once the tool reports its id. */
export function title(tool: ExternalDetect.Tool, session?: string) {
  return session ? `${label(tool)} · ${session.slice(0, 8)}` : label(tool)
}

/** The model a message in an external session records: no Lunos model is involved. */
export function model(tool: ExternalDetect.Tool) {
  return { providerID: ProviderV2.ID.make(PROVIDER), modelID: ModelV2.ID.make(tool) }
}

/** The permission pattern for one of the tool's approvals, as the external_agent tool uses. */
export function patterns(tool: ExternalDetect.Tool, request: ExternalClaude.PermissionRequest) {
  const target = String(request.input.command ?? request.input.file_path ?? request.input.path ?? "*")
  return {
    patterns: [`${tool}:${request.tool} ${target}`],
    always: [`${tool}:${request.tool} ${request.tool === "Bash" ? target : "*"}`],
  }
}

/** Starting an external session is gated like `lunos external run`; returns the refusal, if any. */
export function refused(tool: ExternalDetect.Tool, config: Parameters<typeof ExternalPolicy.check>[1]) {
  try {
    ExternalPolicy.check(tool, config)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * XCOD-254: the tool's models for /models. Claude Code lists them in its answer to `initialize`,
 * Codex through `model/list`; both are asked without a prompt, so no model is called. When Claude
 * Code lists none, its aliases are offered instead (`fallback`). The tool is started only when a
 * turn could start it: allowed by policy, installed, current and signed in.
 */
export async function models(
  tool: ExternalDetect.Tool,
  config: Parameters<typeof ExternalPolicy.check>[1] & { external?: Record<string, any> },
  cwd: string,
): Promise<{ models: ExternalClaude.Model[]; fallback: boolean; error?: string }> {
  // Asking isn't starting: a refusal is reported without an `external.denied` audit, as for /claude's state.
  const refusal = ExternalPolicy.evaluate(tool, config)
  if (refusal) return { models: [], fallback: false, error: refusal.message }
  const status = await ExternalDetect.detect(tool, ExternalRun.configuredPath(tool, config))
  if (!status.installed || status.outdated || status.loggedIn === false || !status.path)
    return { models: [], fallback: false, error: status.hint ?? `${label(tool)} isn't usable here` }
  const listed = await (tool === "claude" ? ExternalClaude : ExternalCodex).models({ executable: status.path, cwd })
  if (listed.length) return { models: listed, fallback: false }
  if (tool === "claude") return { models: ExternalClaude.FALLBACK_MODELS, fallback: true }
  return { models: [], fallback: false, error: `${label(tool)} didn't list its models` }
}

/** Why `model` can't be passed to the tool, if it can't (it reaches Claude Code's command line). */
export function invalidModel(model: string) {
  return ExternalClaude.MODEL_ID.test(model) ? undefined : `"${model}" isn't a model name`
}

/**
 * XCOD-254: save the model a turn passes to the tool (`undefined` goes back to the tool's default).
 * Reads the latest marker right before writing, as a turn's own updates do, so neither loses the other's.
 */
export const setModel = Effect.fn("ExternalSession.setModel")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
  model: string | undefined,
) {
  const latest = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const marker = of(latest)
  if (!marker) return undefined
  const { model: _, ...rest } = marker
  yield* sessions.setMetadata({
    sessionID,
    metadata: { ...latest.metadata, external: model ? { ...rest, model } : rest },
  })
  return { ...rest, ...(model ? { model } : {}) } satisfies Marker
})

export interface Deps {
  sessions: Session.Interface
  permission: Permission.Interface
  agents: Agent.Interface
  config: Config.Interface
  events: EventV2.Interface
  status: SessionStatus.Interface
  /** XCOD-254: what the Lunos bridge offers, and the consent question. */
  mcp: MCP.Interface
  plugin: Plugin.Interface
  memory: Memory.Interface
  skill: Skill.Interface
  question: Question.Interface
}

/** XCOD-254: merges `fields` into the latest marker (as a turn's own writes do, so neither loses the other's). */
const updateMarker = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
  fields: Partial<Marker>,
) {
  const latest = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const marker = of(latest)
  if (!marker) return
  yield* sessions.setMetadata({ sessionID, metadata: { ...latest.metadata, external: { ...marker, ...fields } } })
})

interface Bridge {
  /** What the tool is started with: Claude Code's `--mcp-config` file, or Codex's thread config. */
  launch: { mcpConfig?: string; config?: Record<string, unknown> }
  /** Codex refused the config: the turn runs without the bridge. */
  refused?: (message: string) => void
  /** The tool asks to run one of the bridge's tools (`mcp__lunos__<name>`). */
  owns: (tool: string) => Promise<boolean>
  close: Effect.Effect<void>
}

const NO_BRIDGE: Bridge = { launch: {}, owns: async () => false, close: Effect.void }

/**
 * XCOD-254: the gate for the Lunos bridge, in order. The tool's own gate (external.enabled, the
 * residency policy) has already passed. Then: something is shared (`external.share.*`) and there is
 * something to share; the tool can be given an MCP server; and the user agreed for this tool and
 * project, asked once with Share / Not now / Never. Only then is anything written or started. Each
 * refusal is kept on the session as the status line's reason, and the tool runs as it does today.
 */
interface OpenInput {
  deps: Deps
  sessionID: SessionID
  tool: ExternalDetect.Tool
  marker: Marker
  cfg: Effect.Success<ReturnType<Config.Interface["get"]>>
  supportsMcpConfig: boolean
  agent: string
  agentInfo: Agent.Info | undefined
  ruleset: PermissionV1Type.Ruleset
  worktree: string
  projectKey: string
  settle: () => Promise<unknown>
  pending: Set<PermissionV1Type.ID>
  run: EffectBridgeType.Shape
}

/** Never fails the turn: a bridge that can't start leaves the tool running as it does today, with the reason. */
const openBridge = (input: OpenInput) =>
  open(input).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      const off = `couldn't start: ${error instanceof Error ? error.message : String(error)}`
      return updateMarker(input.deps.sessions, input.sessionID, {
        bridge: { servers: 0, skills: 0, memory: false, off },
      }).pipe(Effect.ignore, Effect.as(NO_BRIDGE))
    }),
  )

const open = Effect.fnUntraced(function* (input: OpenInput) {
  const { deps, sessionID, tool } = input
  const spec = ExternalDetect.TOOLS[tool]
  const off = (reason: string) =>
    updateMarker(deps.sessions, sessionID, { bridge: { servers: 0, skills: 0, memory: false, off: reason } }).pipe(
      Effect.as(NO_BRIDGE),
    )
  const share = ConfigExternal.share(input.cfg.external)
  if (!share.mcp && !share.skills && !share.memory) return yield* off("turned off in external.share")
  if (tool === "claude" && !input.supportsMcpConfig)
    return yield* off(`needs a ${spec.label} whose --help lists --mcp-config`)

  const tools = ExternalBridgeTools.make({
    tool,
    sessionID,
    agent: input.agent,
    agentInfo: input.agentInfo,
    ruleset: input.ruleset,
    config: input.cfg as ExternalBridgeTools.Input["config"],
    worktree: input.worktree,
    settle: input.settle,
    pending: input.pending,
    run: input.run,
    sessions: deps.sessions,
    permission: deps.permission,
    mcp: deps.mcp,
    plugin: deps.plugin,
    memory: deps.memory,
    skill: deps.skill,
  })
  const counts = yield* tools.status()
  // Nothing to offer: no question, and nothing started. Asked once there is something.
  if (!counts.servers && !counts.skills && !counts.memory) return yield* off("nothing to share")

  let answer = yield* Effect.promise(() => ExternalConsent.get(input.projectKey, tool))
  if (answer === "never") return yield* off("never for this tool; change it in /settings → External sessions")
  if (!answer) {
    if (input.marker.consent === "later") return yield* off("not shared in this session")
    const vendor = spec.provider === "anthropic" ? "Anthropic" : "OpenAI"
    const replies = yield* deps.question
      .ask({ sessionID, questions: [ExternalConsent.question(spec.label, vendor)] })
      // Dismissed is Not now; a stopped turn stays stopped and starts nothing.
      .pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined))))
    const choice = ExternalConsent.parse(replies)
    ExternalPolicy.record(input.cfg, "external.consent", { tool, provider: spec.provider, answer: choice })
    if (choice === "later") {
      yield* updateMarker(deps.sessions, sessionID, { consent: "later" })
      return yield* off("not shared in this session")
    }
    yield* Effect.promise(() => ExternalConsent.set(input.projectKey, tool, choice))
    if (choice === "never") return yield* off("never for this tool; change it in /settings → External sessions")
    answer = choice
  }

  const host = yield* Effect.promise(() =>
    ExternalBridge.serve({
      session: sessionID,
      engine: tools.engine,
      onConnect: () =>
        void input.run
          .promise(updateMarker(deps.sessions, sessionID, { bridge: { ...counts, connected: true } }))
          .catch(() => undefined),
    }),
  )
  // Servers added mid-turn (an install from /marketplace) reach the tool without a restart.
  const unlisten = yield* deps.events.listen((event) =>
    event.type === McpEvent.ToolsChanged.type ? Effect.sync(() => host.changed()) : Effect.void,
  )
  let file: { file: string; remove: () => Promise<void> } | undefined
  let refusedBy: string | undefined
  const close = Effect.gen(function* () {
    yield* unlisten
    const connected = host.connected()
    yield* Effect.promise(() => host.close())
    if (file) yield* Effect.promise(() => file!.remove())
    const bridge = refusedBy
      ? { servers: 0, skills: 0, memory: false, off: `${spec.label} refused the bridge: ${refusedBy}` }
      : { ...counts, connected }
    yield* updateMarker(deps.sessions, sessionID, { bridge }).pipe(Effect.ignore)
  })
  const prepared = yield* Effect.gen(function* () {
    if (!ExternalBridge.command(sessionID)) return { off: "Lunos can't find its own command (no lunos on PATH)" }
    if (tool !== "claude") return { launch: { config: ExternalBridge.codexConfig(sessionID, host) } }
    file = yield* Effect.promise(() => ExternalBridge.claudeConfig(sessionID, host))
    if (!ExternalClaude.PATH_ARG.test(file.file))
      return { off: `the temporary directory's path can't be passed to ${spec.label}` }
    return { launch: { mcpConfig: file.file } }
  }).pipe(Effect.onError(() => close))
  if (prepared.off) {
    yield* close
    return yield* off(prepared.off)
  }
  const launch: Bridge["launch"] = prepared.launch!
  yield* updateMarker(deps.sessions, sessionID, { bridge: { ...counts } })
  ExternalPolicy.record(input.cfg, "external.bridge", {
    tool,
    provider: spec.provider,
    servers: counts.servers,
    skills: counts.skills,
    memory: counts.memory,
  })
  // Claude Code names an MCP tool this way, and so does the Codex adapter for an `mcpToolCall`.
  const prefix = `mcp__${ExternalBridge.SERVER}__`
  return {
    launch,
    refused: (message: string) => {
      refusedBy = message
    },
    owns: async (name: string) => {
      if (!name.startsWith(prefix)) return false
      const listed = await tools.engine.list().catch(() => [])
      return listed.some((item) => item.name === name.slice(prefix.length))
    },
    close,
  } satisfies Bridge
})

/** Runs one turn of the tool for the session's last user message. */
export const turn = Effect.fn("ExternalSession.turn")(function* (deps: Deps, sessionID: SessionID) {
  const { sessions, permission } = deps
  const ctx = yield* InstanceState.context
  const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const marker = of(session)!
  const tool = marker.tool
  const spec = ExternalDetect.TOOLS[tool]
  const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
  const lastUser = msgs.findLast((msg) => msg.info.role === "user")
  if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
  const answered = msgs.findLast(
    (msg) => msg.info.role === "assistant" && msg.info.parentID === lastUser.info.id && !!msg.info.time.completed,
  )
  if (answered) return answered
  yield* deps.status.set(sessionID, { type: "busy" })

  const prompt = lastUser.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("\n")
    .trim()
  const cfg = yield* deps.config.get()
  const agent = yield* deps.agents.get(lastUser.info.agent)
  // The same rules a tool call in this session would be judged by (agent, then session).
  const ruleset = [...(agent?.permission ?? []), ...(session.permission ?? [])]

  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    parentID: lastUser.info.id as MessageID,
    role: "assistant",
    mode: spec.label,
    agent: lastUser.info.agent,
    path: { cwd: ctx.directory, root: ctx.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...model(tool),
    time: { created: Date.now() },
    sessionID,
  }
  yield* sessions.updateMessage(msg)

  const finish = Effect.fnUntraced(function* (error?: string) {
    msg.time.completed = Date.now()
    msg.finish = error ? "error" : "stop"
    if (error) {
      msg.error = new NamedError.Unknown({ message: error }).toObject()
      yield* deps.events.publish(SessionV1.Event.Error, { sessionID, error: msg.error }).pipe(Effect.ignore)
    }
    yield* sessions.updateMessage(msg)
    return { info: msg, parts: [] as SessionV1.Part[] } satisfies SessionV1.WithParts
  })

  // Same gate as `lunos external run`, every turn: a resume after a policy change is refused too.
  const refusal = refused(tool, cfg)
  if (refusal) return yield* finish(refusal)
  if (!prompt) return yield* finish(`Nothing to send to ${spec.label}.`)
  const status = yield* Effect.promise(() => ExternalDetect.detect(tool, ExternalRun.configuredPath(tool, cfg)))
  if (!status.installed || status.outdated || status.loggedIn === false)
    return yield* finish(status.hint ?? `${spec.label} isn't usable here`)

  const bridge = yield* EffectBridge.make()
  // The tool's events arrive outside this fiber; one chain keeps their writes in order.
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = (effect: Effect.Effect<unknown>) => {
    chain = chain.then(() => bridge.promise(effect)).catch(() => undefined)
  }
  const tools = new Map<string, SessionV1.ToolPart>()
  // XCOD-254: Lunos plugin hooks on the tool's own calls (`external.share.hooks`). They run here, on
  // this machine, so they don't wait for consent: a deny hook works whether or not anything is shared.
  const hooks = ConfigExternal.share(cfg.external).hooks
  /** The tool's calls by id, as hooks see them; and those refused, which never ran (no after hook). */
  const calls = new Map<string, ReturnType<typeof ExternalHooks.call> & { name: string }>()
  const refusedCalls = new Set<string>()
  const pending = new Set<PermissionV1.ID>()
  const started = new Date().toISOString()
  let current = marker.session
  let streamed = ""

  const remember = (id: string, commands?: string[]) =>
    Effect.gen(function* () {
      const latest = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const previous = of(latest) ?? marker
      yield* sessions.setMetadata({
        sessionID,
        metadata: {
          ...latest.metadata,
          external: { ...previous, session: id, ...(commands ? { commands } : {}) },
        },
      })
      if (latest.title === title(tool) || latest.title === title(tool, previous.session))
        yield* sessions.setTitle({ sessionID, title: title(tool, id) })
    })

  // XCOD-254: the Lunos bridge for this turn, when the user agreed to share with this tool.
  const lunos = yield* openBridge({
    deps,
    sessionID,
    tool,
    marker,
    cfg,
    supportsMcpConfig: status.mcpConfig === true,
    agent: lastUser.info.agent,
    agentInfo: agent,
    ruleset,
    worktree: ctx.worktree,
    projectKey: ExternalConsent.project(ctx),
    settle: () => chain,
    pending,
    run: bridge,
  })

  const execute = Effect.gen(function* () {
    let running: ExternalClaude.Running
    try {
      running = ExternalRun.start({
        tool,
        cwd: ctx.directory,
        prompt,
        resume: marker.session,
        ...ConfigExternal.launch(tool, cfg.external),
        // XCOD-254: each turn is a fresh start of the tool, so the model chosen with /models applies
        // from the next turn on (`--model` / Codex's thread `model`), resumes included.
        ...(marker.model ? { model: marker.model } : {}),
        ...lunos.launch,
        onConfigRefused: lunos.refused,
        executable: status.path,
        onEvent: (event) => {
          if (event.type === "init") {
            current = event.sessionID
            msg.modelID = ModelV2.ID.make(event.model ?? tool)
            enqueue(
              Effect.gen(function* () {
                yield* sessions.updateMessage(msg)
                yield* remember(event.sessionID, event.commands.length ? event.commands : undefined)
                yield* Effect.promise(() =>
                  ExternalRegistry.save({
                    sessionID: event.sessionID,
                    tool,
                    cwd: ctx.directory,
                    started,
                    updated: new Date().toISOString(),
                    status: "running",
                    pid: running?.child.pid,
                  }),
                )
              }),
            )
          }
          if (event.type === "text") {
            streamed = event.text
            const now = Date.now()
            enqueue(
              sessions.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID,
                type: "text",
                text: event.text,
                time: { start: now, end: now },
              } satisfies SessionV1.TextPart),
            )
          }
          if (event.type === "tool") {
            const part: SessionV1.ToolPart = {
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID,
              type: "tool",
              callID: event.id,
              tool: `${tool}:${event.name}`,
              state: {
                status: "running",
                input: (event.input ?? {}) as Record<string, unknown>,
                title: event.name,
                time: { start: Date.now() },
              },
            }
            tools.set(event.id, part)
            calls.set(event.id, { ...ExternalHooks.call(tool, event.name, event.input), name: event.name })
            enqueue(sessions.updatePart(part))
          }
          if (event.type === "tool_result") {
            const part = tools.get(event.id)
            if (!part || part.state.status !== "running") return
            const start = part.state.time.start
            part.state = event.isError
              ? { status: "error", input: part.state.input, error: event.output, time: { start, end: Date.now() } }
              : {
                  status: "completed",
                  input: part.state.input,
                  output: event.output,
                  title: part.state.title ?? "",
                  metadata: {},
                  time: { start, end: Date.now() },
                }
            enqueue(sessions.updatePart({ ...part }))
            // XCOD-254: Lunos's post-tool hooks, on a call that ran. A bridge call ran them already, in
            // the bridge. Observational, as in a Lunos session: a failing hook never fails the turn.
            const call = calls.get(event.id)
            if (hooks && call && !refusedCalls.has(event.id))
              enqueue(
                Effect.gen(function* () {
                  if (yield* Effect.promise(() => lunos.owns(call.name))) return
                  yield* deps.plugin.trigger(
                    "tool.execute.after",
                    { tool: call.tool, sessionID, agent: lastUser.info.agent, callID: event.id, args: call.args },
                    { title: call.name, output: event.output, metadata: { external: tool } },
                  )
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("external tool.execute.after hook failed", { cause: Cause.pretty(cause) }),
                  ),
                ),
              )
          }
        },
        ask: async (request) => {
          // XCOD-254: a call to the Lunos bridge asks in Lunos when it reaches the bridge (with the
          // tool it really runs), so the tool's own approval of it isn't asked twice. Only the names
          // the bridge lists right now: a server of the user's own called "lunos" still asks.
          if (await lunos.owns(request.tool)) return { allow: true }
          const callID = request.toolUseID ?? request.requestID
          // XCOD-254: Lunos's pre-tool hooks run before Lunos asks, as in a Lunos session, where a hook
          // that throws refuses the call and the model carries on with the error.
          if (hooks) {
            const call = { ...ExternalHooks.call(tool, request.tool, request.input), name: request.tool }
            calls.set(callID, call)
            const hooked = await bridge.promise(
              Effect.exit(
                deps.plugin.trigger(
                  "tool.execute.before",
                  { tool: call.tool, sessionID, agent: lastUser.info.agent, callID, external: tool },
                  { args: call.args },
                ),
              ),
            )
            if (Exit.isFailure(hooked)) {
              refusedCalls.add(callID)
              return { allow: false, message: ExternalHooks.refusal(Cause.squash(hooked.cause)) }
            }
          }
          const id = PermissionV1.ID.ascending()
          pending.add(id)
          const exit = await bridge.promise(
            Effect.exit(
              permission.ask({
                id,
                sessionID,
                permission: "external",
                ...patterns(tool, request),
                // Only JSON values: the request is sent to clients as is (an undefined field fails encoding).
                metadata: {
                  tool,
                  label: spec.label,
                  action: request.tool,
                  ...(request.description ? { description: request.description } : {}),
                  input: JSON.parse(JSON.stringify(request.input ?? {})),
                },
                ruleset,
              }),
            ),
          )
          pending.delete(id)
          if (Exit.isSuccess(exit)) return { allow: true }
          refusedCalls.add(callID)
          // As in a Lunos session: a refusal with feedback is passed on and the tool carries on; a
          // plain refusal also ends the tool's turn (Claude Code's `interrupt`); a deny rule just refuses.
          const error = Cause.squash(exit.cause)
          if (error instanceof PermissionV1.CorrectedError) return { allow: false, message: error.feedback }
          if (error instanceof PermissionV1.RejectedError)
            return { allow: false, message: "The user refused this in Lunos.", interrupt: true }
          return { allow: false, message: "Refused by a Lunos permission rule." }
        },
      })
    } catch (error) {
      // An approval-skipping mode without --unsafe, a malformed id, or a Codex command it can't run headless.
      return yield* finish(error instanceof Error ? error.message : String(error))
    }

    const settle = Effect.promise(() => chain)
    const result = yield* Effect.promise(() => running.done).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          // Stop: refuse what is still waiting for an answer, then end the tool's turn.
          for (const id of pending) yield* permission.reply({ requestID: id, reply: "reject" }).pipe(Effect.ignore)
          running.stop()
          yield* settle
          msg.time.completed = Date.now()
          msg.error = new SessionV1.AbortedError({ message: `${spec.label} was stopped` }).toObject()
          yield* sessions.updateMessage(msg)
          if (current)
            yield* Effect.promise(() =>
              ExternalRegistry.save({
                sessionID: current!,
                tool,
                cwd: ctx.directory,
                started,
                updated: new Date().toISOString(),
                status: "stopped",
              }),
            )
        }),
      ),
    )
    yield* settle

    const provider = spec.provider
    if (result.type === "error") {
      ExternalPolicy.record(cfg, "external.session", { tool, provider, outcome: "error", tab: true })
      if (current)
        yield* Effect.promise(() =>
          ExternalRegistry.save({
            sessionID: current!,
            tool,
            cwd: ctx.directory,
            started,
            updated: new Date().toISOString(),
            status: "failed",
          }),
        )
      return yield* finish(result.message)
    }

    // The result restates the last message; shown only when nothing was streamed (e.g. a /command's output).
    if (result.text && !streamed.trim())
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text: result.text,
        time: { start: Date.now(), end: Date.now() },
      } satisfies SessionV1.TextPart)
    if (result.sessionID && result.sessionID !== of(yield* sessions.get(sessionID).pipe(Effect.orDie))?.session)
      yield* remember(result.sessionID)

    const tokens = {
      ...(result.tokens !== undefined ? { total: result.tokens } : {}),
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    msg.cost = result.costUSD ?? 0
    msg.tokens = tokens
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "step-finish",
      reason: result.ok ? "stop" : result.subtype,
      cost: msg.cost,
      tokens,
    } satisfies SessionV1.StepFinishPart)
    // Republish the session so clients see the new total (the step's cost was just added to it).
    yield* sessions.touch(sessionID)

    ExternalPolicy.record(cfg, "external.session", {
      tool,
      provider,
      session: result.sessionID,
      outcome: result.ok ? "success" : result.subtype,
      cost_usd: result.costUSD,
      tokens: result.tokens,
      turns: result.turns,
      denied: result.denied.length,
      resumed: marker.session !== undefined,
      tab: true,
    })
    yield* Effect.promise(() =>
      ExternalRegistry.save({
        sessionID: result.sessionID,
        tool,
        cwd: ctx.directory,
        started,
        updated: new Date().toISOString(),
        status: result.ok ? "done" : "failed",
        costUSD: result.costUSD,
        turns: result.turns,
      }),
    )
    return yield* finish(result.ok ? undefined : `${spec.label} ended the turn: ${result.subtype}`)
  })
  return yield* execute.pipe(Effect.ensuring(lunos.close))
})
