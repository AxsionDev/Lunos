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
import type { ExternalClaude } from "./claude"

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

export interface Deps {
  sessions: Session.Interface
  permission: Permission.Interface
  agents: Agent.Interface
  config: Config.Interface
  events: EventV2.Interface
  status: SessionStatus.Interface
}

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

  let running: ExternalClaude.Running
  try {
    running = ExternalRun.start({
      tool,
      cwd: ctx.directory,
      prompt,
      resume: marker.session,
      ...ConfigExternal.launch(tool, cfg.external),
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
        }
      },
      ask: async (request) => {
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
