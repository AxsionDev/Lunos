import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigPolicy } from "@/config/policy"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { backgroundEnabled } from "@/background/enabled"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, DEFAULT_MAX_PARALLEL, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { AutoContinue } from "./auto-continue"
import { DevCycle } from "./dev-cycle"
import { DynamicWorkflows } from "./workflows"
import { BackgroundJob } from "@/background/job"
import { Memory } from "@/memory"
import { MemorySources } from "@/memory/sources"
import { Resource } from "@/resource"
import type { ResourceCore } from "@/resource/resource"
import { Token } from "@/util/token"
import { Skill } from "@/skill"
import { Question } from "@/question"
import { SessionTools } from "./tools"
import { SandboxGuard } from "@/sandbox/guard"
import { RunBudget } from "@/agent/run-budget"
import { Budget } from "@/budget"
import { BUDGET_TOAST_TITLE } from "@opencode-ai/tui/util/budget-toast"
import { ExternalSession } from "@/external/session"
import { LLMEvent } from "@opencode-ai/llm"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

import BUILD_PROOF from "./prompt/build-proof.txt"
import QA_PROOF from "./prompt/qa-proof.txt"
import { BackgroundShell } from "@/tool/shell/background"

type VerifyConfig = {
  build?: string
  test?: string
  start?: string
  ready?: string
  check?: readonly string[]
  max_attempts?: number
  timeout?: number
}

/** XCOD-288: the checks a project pins in `verify`, one line each. */
export function verifyChecks(verify: VerifyConfig | undefined) {
  const v = verify ?? {}
  return [
    v.build ? `- build: \`${v.build}\`` : undefined,
    v.test ? `- test: \`${v.test}\`` : undefined,
    v.start ? `- start (in the background): \`${v.start}\`` : undefined,
    v.ready ? `- ready when this answers: ${v.ready}` : undefined,
    ...(v.check ?? []).map((check) => `- check: ${check}`),
  ].filter((line): line is string => line !== undefined)
}

/**
 * XCOD-288: the build agent finishes with proof (it builds, tests, starts and tries what it changed)
 * rather than asking the user to test. Not for other agents, not where the shell is denied, and not
 * when `agent.build.verify` is false. Commands pinned in `verify` replace what it would look up.
 * XCOD-303: nor in a Dynamic workflow, where the main agent has no shell and `qa` verifies instead.
 */
export function buildProof(
  agent: { name: string; permission: PermissionV1.Ruleset },
  session?: PermissionV1.Ruleset,
  cfg: { verify?: VerifyConfig; agent?: Record<string, { verify?: boolean } | undefined> } = {},
  dynamic = false,
) {
  if (agent.name !== "build" || dynamic) return
  if (cfg.agent?.[agent.name]?.verify === false) return
  const ruleset = Permission.merge(agent.permission, session ?? [])
  if (Permission.disabled([ShellID.ToolID], ruleset).has(ShellID.ToolID)) return
  const verify = cfg.verify ?? {}
  const pinned = verifyChecks(verify)
  return BUILD_PROOF.replace(
    "${pinned}",
    pinned.length ? `\n\nThis project pins these; use them instead of looking for your own:\n${pinned.join("\n")}` : "",
  )
    .replace("${attempts}", String(verify.max_attempts ?? 3))
    .replace("${minutes}", String(verify.timeout ?? 10))
}

/**
 * XCOD-303: the `qa` subagent verifies the same way and ends with the same Verification block, but
 * reports a failure rather than fixing it. Not where its shell is denied.
 */
export function qaProof(
  agent: { name: string; permission: PermissionV1.Ruleset },
  session?: PermissionV1.Ruleset,
  cfg: { verify?: VerifyConfig } = {},
) {
  if (agent.name !== "qa") return
  if (Permission.disabled([ShellID.ToolID], Permission.merge(agent.permission, session ?? [])).has(ShellID.ToolID))
    return
  const pinned = verifyChecks(cfg.verify)
  return QA_PROOF.replace(
    "${pinned}",
    pinned.length ? `\n\nThis project pins these; use them instead of looking for your own:\n${pinned.join("\n")}` : "",
  )
}

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const memory = yield* Memory.Service
    const memorySources = yield* MemorySources.Service
    const resources = yield* Resource.Service
    const skill = yield* Skill.Service
    const question = yield* Question.Service
    const jobs = yield* BackgroundJob.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const { db } = database
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      // XCOD-308: a name the user gave is never replaced.
      if (Session.titleSource(input.session) === "user") return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      // Only on the first prompt, unless the user cleared the name (then on the next turn).
      if (input.history.filter(real).length !== 1 && !Session.titleReset(input.session)) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        // Only over the title it started from: a rename made while this was generated wins.
        .setTitle({ sessionID: input.session.id, title: t, source: "auto", replace: input.session.title })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, agent: lastUser.agent, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, agent: lastUser.agent, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      // XCOD-214 (PO, 2026-10-07): a model from config or --model that isn't available here is a
      // warning: the next best one is used instead of failing the prompt.
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const resolved = yield* provider.resolve(providerID, modelID).pipe(Effect.option)
        if (Option.isSome(resolved) && resolved.value.warning) {
          const next = yield* provider.getModel(resolved.value.providerID, resolved.value.modelID).pipe(Effect.option)
          if (Option.isSome(next)) {
            yield* Effect.logWarning(resolved.value.warning)
            yield* events
              .publish(TuiEvent.ToastShow, {
                title: "Model not available",
                message: resolved.value.warning,
                variant: "warning",
                duration: 8000,
              })
              .pipe(Effect.ignore)
            return next.value
          }
        }
      }
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      // XCOD-219: under a locked `model` (or `agent.<name>.model`) a main session runs on the locked
      // model. Asking for another one is refused with the policy message and audited; a model that
      // only came from an agent's own config or the session's history is replaced. Subagent sessions
      // follow the subagent locks, checked by the task tool.
      // XCOD-218: no Lunos model answers in an external session, whatever the client sent, so the
      // model lock doesn't apply there; the external tool's own policy gate does.
      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const external = ExternalSession.of(current)
      const lock = external || current.parentID ? undefined : ConfigPolicy.lockedModel(yield* config.get(), ag.name)
      if (lock && input.model && `${input.model.providerID}/${input.model.modelID}` !== lock.model) {
        yield* ConfigPolicy.refused(lock.key, `session model ${input.model.providerID}/${input.model.modelID}`)
        const reason = ConfigPolicy.modelLockReason(lock)
        const error = new NamedError.Unknown({ message: reason })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw new ConfigPolicy.LockedError(lock.key, "session model", reason)
      }
      const model = external
        ? ExternalSession.model(external.tool)
        : lock
          ? Provider.parseModel(lock.model)
          : (input.model ?? ag.model ?? (yield* currentModel(input.sessionID)))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    /** XCOD-298: the budget guard's decision, acted on: a toast, a question, or the turn stopped. */
    const budgetCheck = Effect.fn("SessionPrompt.budget")(function* (input: {
      sessionID: SessionID
      session: Session.Info
      step: number
      model: Provider.Model
      msgs: SessionV1.WithParts[]
      lastUser: SessionV1.User
    }) {
      const ctx = yield* InstanceState.context
      const cfg = yield* config.get()
      const decision = yield* Budget.guard({
        session: { id: input.sessionID, ...(input.session.parentID ? { parentID: input.session.parentID } : {}) },
        directory: input.session.directory ?? ctx.directory,
        project: { id: ctx.project.id, worktree: ctx.project.worktree, name: ctx.project.name },
        config: cfg as Budget.Config,
        start: input.step === 1,
        price: input.model.cost,
        model: `${input.model.providerID}/${input.model.id}`,
        turn: Budget.turnsOf(input.msgs),
      }).pipe(
        Effect.provideService(Database.Service, database),
        // A budget that can't be read never stops work; it's logged.
        Effect.catchCause((cause) =>
          Effect.logWarning("budget check failed", { "session.id": input.sessionID, cause }).pipe(
            Effect.as({ action: "run", toasts: [] } as Budget.Decision),
          ),
        ),
      )
      const toast = (message: string, variant: "warning" | "error" = "warning") =>
        events
          .publish(TuiEvent.ToastShow, { title: BUDGET_TOAST_TITLE, message, variant, duration: 10000 })
          .pipe(Effect.ignore)
      for (const message of decision.toasts) yield* toast(message)
      if (decision.action === "run") return "run" as const
      if (decision.action === "warn") {
        yield* toast(decision.message)
        return "run" as const
      }
      if (decision.action === "ask") {
        const RUN = "Run anyway"
        const CHEAPER = "Use a cheaper model…"
        const answers = yield* question
          .ask({
            sessionID: input.sessionID,
            questions: [
              {
                header: "Budget",
                question: decision.message,
                custom: false,
                options: [
                  { label: RUN, description: "Run this turn; the overspend is shown" },
                  { label: CHEAPER, description: "Stop, and pick another model for the next turn" },
                  { label: "Stop", description: "Don't start it" },
                ],
              },
            ],
          })
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ReadonlyArray<string>>)))
        const answer = answers[0]?.[0]
        if (answer === RUN) {
          Budget.approve(decision.root)
          return "run" as const
        }
        if (answer === CHEAPER)
          yield* events.publish(TuiEvent.CommandExecute, { command: "model.list" }).pipe(Effect.ignore)
        yield* Effect.logInfo("budget: turn not started", { "session.id": input.sessionID, answer })
        return "stop" as const
      }
      // stop: the reason, on the session and as its error (`lunos run` exits with code 3 on it).
      const error = new NamedError.Unknown({ message: decision.message, ref: "budget" }).toObject()
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        parentID: input.lastUser.id,
        role: "assistant",
        mode: input.lastUser.agent,
        agent: input.lastUser.agent,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.model.id,
        providerID: input.model.providerID,
        time: { created: Date.now(), completed: Date.now() },
        sessionID: input.sessionID,
        finish: "stop",
        error: error as SessionV1.Assistant["error"],
      }
      yield* sessions.updateMessage(msg)
      yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: msg.error })
      return "stop" as const
    })

    /**
     * XCOD-302: when a Dev-Cycle or Build turn ends by announcing its next step instead of taking
     * it, send an internal continuation rather than wait for "proceed". Returns whether it did (the
     * loop then runs another step). Never past a pending gate; at most `AutoContinue.MAX` in a row
     * without progress, then the human is asked.
     */
    const autoContinue = Effect.fn("SessionPrompt.autoContinue")(function* (input: {
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
      lastUser: SessionV1.User
      step: number
    }) {
      // Not for subagents: their parent reads the result and carries on itself.
      if (input.session.parentID) return false
      // XCOD-303: nor while subagents it dispatched in the background still run: each one's result
      // resumes the session when it lands, so a turn that ends waiting for them hasn't stalled.
      const running = (yield* jobs.list()).some(
        (job) => job.status === "running" && job.metadata?.parentSessionId === input.sessionID,
      )
      if (running) return false
      const agent = yield* agents.get(input.lastUser.agent)
      if (!agent || (agent.name !== "dev-cycle" && agent.name !== "build")) return false
      const cfg = yield* config.get()
      const cycle = agent.name === "dev-cycle"
      if (cycle ? cfg.dev_cycle?.auto_continue === false : cfg.agent?.[agent.name]?.auto_continue === false)
        return false
      const title = cycle ? "Dev-Cycle" : "Build"

      let position: AutoContinue.Position = { unknown: false, done: false, pending: false }
      let file: string | undefined
      if (cycle) {
        file = Session.devcycle(input.session, yield* InstanceState.context)
        const exists = yield* fsys.existsSafe(file)
        const contents = exists
          ? yield* fsys.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        position = DevCycle.position({ exists, contents })
      }
      // Continuations count against the step limit like any step; at the limit the turn stops.
      const stop = AutoContinue.classify({
        messages: input.msgs,
        position,
        emptyStalls: cycle,
        limit: input.step >= (agent.steps ?? Infinity) ? "step limit" : undefined,
      })
      if (stop.kind !== "stalled") {
        if (stop.kind !== "finished")
          yield* Effect.logInfo("auto-continue: stopped", { "session.id": input.sessionID, stop: stop.kind })
        return false
      }

      const send = (text: string, metadata: Record<string, unknown>, synthetic: boolean) =>
        Effect.gen(function* () {
          const message = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: input.lastUser.agent,
            model: input.lastUser.model,
            ...(input.lastUser.format ? { format: input.lastUser.format } : {}),
            ...(input.lastUser.system ? { system: input.lastUser.system } : {}),
            ...(input.lastUser.tools ? { tools: input.lastUser.tools } : {}),
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: message.id,
            sessionID: input.sessionID,
            type: "text",
            text,
            synthetic,
            metadata,
            time: { start: Date.now(), end: Date.now() },
          })
        })

      const attempt = AutoContinue.streak(input.msgs)
      if (attempt >= AutoContinue.MAX) {
        const CONTINUE = "Continue"
        const OPEN = "Open cycle file"
        const answers = yield* question
          .ask({
            sessionID: input.sessionID,
            questions: [
              {
                header: title,
                question: AutoContinue.gaveUp(title),
                custom: false,
                options: [
                  { label: CONTINUE, description: "Try again" },
                  cycle
                    ? { label: OPEN, description: `Stop, and open the cycle file${file ? ` (${file})` : ""}` }
                    : { label: "Stop", description: "Leave it here" },
                ],
              },
            ],
          })
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ReadonlyArray<string>>)))
        const answer = answers[0]?.[0]
        yield* Effect.logInfo("auto-continue: no progress", { "session.id": input.sessionID, answer })
        if (answer === OPEN)
          yield* events.publish(TuiEvent.CommandExecute, { command: "artifact.list" }).pipe(Effect.ignore)
        if (answer !== CONTINUE) return false
        // The human pressed Continue: a fresh start for the streak, and never an approval of a gate.
        yield* send("Continue.", { [AutoContinue.RESUME]: true }, false)
        return true
      }

      const line = AutoContinue.line(title, stop.label)
      yield* send(
        AutoContinue.prompt({ gated: cycle, note: stop.note }),
        { [AutoContinue.METADATA]: { label: line, attempt: attempt + 1 } },
        true,
      )
      yield* Effect.logInfo("auto-continue", { "session.id": input.sessionID, line, attempt: attempt + 1 })
      return true
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastAssistant.parentID === lastUser.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            // XCOD-302: only a turn this loop ran; resuming an idle session never re-continues an old one.
            if (!orphan && step > 0 && (yield* autoContinue({ sessionID, session, msgs, lastUser, step }))) continue
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            break
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          // XCOD-211: an unattended run's step and spend limits, subagents included, checked before the
          // model call.
          if (!RunBudget.take()) {
            yield* Effect.logInfo("unattended run limit reached", { "session.id": sessionID })
            break
          }
          // XCOD-298: project and organisation budgets, before every step (subagents' included). A step
          // already running always finishes; this decides whether the next one starts.
          const budget = yield* budgetCheck({ sessionID, session, step, model, msgs, lastUser })
          if (budget === "stop") break
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          // XCOD-287: Build's nudge to split development work across subagents.
          const stepConfig = yield* config.get()
          const subagents = (yield* agents.list()).filter((item) => item.mode !== "primary")
          const stepBackground = backgroundEnabled(flags.experimentalBackgroundSubagents, stepConfig)
          // XCOD-303: Dynamic workflows, read every step so `/workflows on|off` applies to the next one.
          const dynamic = DynamicWorkflows.decide({
            config: stepConfig,
            agent,
            session: {
              ...session,
              metadata: (yield* sessions.get(sessionID).pipe(Effect.orDie)).metadata,
            },
            subagents,
          }).on
          const delegate =
            dynamic && agent.name === "build"
              ? SessionReminders.dynamicReminder({
                  background: stepBackground,
                  maxParallel: stepConfig.subagent?.max_parallel ?? DEFAULT_MAX_PARALLEL,
                })
              : !dynamic && SessionReminders.delegates({ agent, session, config: stepConfig, subagents })
                ? SessionReminders.delegateReminder(stepBackground)
                : undefined
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session, delegate, dynamic }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )
          // XCOD-94: recalled memory, computed once per user message and never saved, like the
          // reminders above. Skipped for an agent whose permission denies memory.
          const memoryUser = msgs.findLast((m) => m.info.role === "user")
          if (memoryUser && !Permission.disabled(["memory_search"], agent.permission).size) {
            const query = memoryUser.parts
              .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
              .join("\n")
              .trim()
            const recalled = query
              ? yield* memory.recallFor({
                  sessionID,
                  userMessageID: memoryUser.info.id,
                  query,
                  parent: { providerID: model.providerID, modelID: model.id },
                })
              : undefined
            if (recalled)
              memoryUser.parts.push({
                id: PartID.ascending(),
                messageID: memoryUser.info.id,
                sessionID,
                type: "text",
                text: recalled,
                synthetic: true,
              })
          }
          // XCOD-300: project resources the user mentioned as @name, added to their message for this
          // turn only (never saved), like recalled memory. Images and PDFs only for models that take them.
          let mentionedTokens = 0
          if (memoryUser) {
            const typed = memoryUser.parts
              .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
              .join("\n")
            const mentioned = typed.includes("@")
              ? yield* resources
                  .mention({
                    sessionID,
                    text: typed,
                    image: model.capabilities.input.image,
                    pdf: model.capabilities.input.pdf,
                  })
                  .pipe(Effect.orElseSucceed(() => ({ parts: [], tokens: 0, names: [] })))
              : undefined
            mentionedTokens = mentioned?.tokens ?? 0
            for (const part of mentioned?.parts ?? [])
              memoryUser.parts.push(
                part.type === "text"
                  ? {
                      id: PartID.ascending(),
                      messageID: memoryUser.info.id,
                      sessionID,
                      type: "text",
                      text: part.text,
                      synthetic: true,
                    }
                  : {
                      id: PartID.ascending(),
                      messageID: memoryUser.info.id,
                      sessionID,
                      type: "file",
                      mime: part.mime,
                      url: part.url,
                      filename: part.filename,
                    },
              )
          }

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()

            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
              Effect.provideService(RuntimeFlags.Service, flags),
              Effect.provideService(Memory.Service, memory),
            )
            // XCOD-157: with sandbox.required, no tool runs outside a sandbox, whatever started this session.
            SandboxGuard.guard(tools, (yield* config.get()).sandbox, sessionID)
            // XCOD-303: in a Dynamic workflow the main agent coordinates and subagents do the work: no
            // edit, write or command tool reaches the model. Dev-Cycle keeps editing its own cycle file.
            if (dynamic) {
              const dropped = DynamicWorkflows.gate(tools, {
                directory: ctx.directory,
                ...(agent.name === "dev-cycle" ? { allowFile: Session.devcycle(session, ctx) } : {}),
              })
              if (step === 1) yield* Effect.logInfo("dynamic workflow", { "session.id": sessionID, dropped })
            }

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              sys.environment(model),
              instruction.system().pipe(Effect.orDie),
              sys.mcp(agent, session.permission),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const proofConfig = yield* config.get()
            const proof =
              buildProof(agent, session.permission, proofConfig, dynamic) ??
              qaProof(agent, session.permission, proofConfig)
            // XCOD-300: the project's resources: the list (with how to reach each) and the Always ones in full.
            const projectResources = yield* resources.system(sessionID).pipe(
              Effect.orElseSucceed(() => ({
                catalog: undefined as string | undefined,
                always: { included: [], dropped: [], tokens: 0 } as ResourceCore.Always,
              })),
            )
            const system = [
              ...env,
              ...instructions,
              ...(mcpInstructions ? [mcpInstructions] : []),
              ...(skills ? [skills] : []),
              ...(proof ? [proof] : []),
              ...(projectResources.catalog ? [projectResources.catalog] : []),
              ...(projectResources.always.text ? [projectResources.always.text] : []),
            ]
            yield* resources.record(
              sessionID,
              contextBreakdown({
                model,
                system: [
                  ...env,
                  ...(mcpInstructions ? [mcpInstructions] : []),
                  ...(skills ? [skills] : []),
                  ...(proof ? [proof] : []),
                  projectResources.catalog ?? "",
                ],
                instructions,
                always: projectResources.always,
                messages: msgs,
                mentioned: mentionedTokens,
              }),
            )
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [
                ...modelMsgs,
                ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
              ],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      // XCOD-218: an external session's reply comes from Claude Code / Codex, not a Lunos model.
      const info = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (ExternalSession.of(info))
        return yield* state.ensureRunning(
          input.sessionID,
          lastAssistant(input.sessionID),
          ExternalSession.turn(
            { sessions, permission, agents, config, events, status, mcp, plugin, memory, skill, question },
            input.sessionID,
          ),
        )
      return yield* state.ensureRunning(
        input.sessionID,
        lastAssistant(input.sessionID),
        // XCOD-288: background commands this turn started and didn't keep stop with it, however
        // it ends (finished, failed or interrupted).
        runLoop(input.sessionID).pipe(Effect.ensuring(Effect.promise(() => BackgroundShell.endTurn(input.sessionID)))),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      // XCOD-94: /memory off | on switches memory for this session and records that in the
      // transcript without calling a model.
      if (input.command === Command.Default.MEMORY) {
        const arg = input.arguments.trim().toLowerCase()
        if (arg === "off" || arg === "on") yield* memory.setSessionOff(input.sessionID, arg === "off")
        const verdict = yield* memory.decision(input.sessionID)
        let status = verdict.on ? "Memory is on for this session." : `Memory is off: ${verdict.reason}.`
        // XCOD-135: /memory sources [on|off <name>] lists external sources, or toggles one for this session.
        const [sub, toggle, ...rest] = input.arguments.trim().split(/\s+/)
        if (sub?.toLowerCase() === "sources") {
          const name = rest.join(" ")
          const known =
            (toggle === "on" || toggle === "off") && name
              ? yield* memorySources.setSessionOff(input.sessionID, name, toggle === "off")
              : undefined
          status =
            (known === false ? `No memory source is named "${name}".\n\n` : "") +
            MemorySources.describe(yield* memorySources.list(input.sessionID), verdict.on)
        }
        return yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: input.model ? Provider.parseModel(input.model) : yield* currentModel(input.sessionID),
          agent: input.agent,
          parts: [{ type: "text", text: `/memory${arg ? " " + input.arguments.trim() : ""}\n\n${status}` }],
          noReply: true,
        })
      }

      // XCOD-303: /workflows off | on switches Dynamic workflows for this session (session metadata,
      // read by the loop every step) and records that in the transcript without calling a model. An
      // organisation lock can't be overridden: the attempt is refused and the reason shown.
      if (input.command === Command.Default.WORKFLOWS) {
        const arg = input.arguments.trim().toLowerCase()
        const cfg = yield* config.get()
        const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        const before = DynamicWorkflows.setting({
          config: cfg,
          session: DynamicWorkflows.sessionValue(current.metadata),
        })
        let refusal = ""
        if (arg === "off" || arg === "on") {
          if (before.locked) {
            yield* ConfigPolicy.refused(DynamicWorkflows.KEY, "/workflows")
            refusal = `Can't turn Dynamic workflows ${arg}: ${ConfigPolicy.message(DynamicWorkflows.KEY)}.\n\n`
          } else
            yield* sessions.setMetadata({
              sessionID: input.sessionID,
              metadata: DynamicWorkflows.withSessionValue(current.metadata, arg === "on"),
            })
        }
        // A lock wins over the session value, so after a refusal this still reads the lock.
        const after = DynamicWorkflows.setting({
          config: cfg,
          session: arg === "off" || arg === "on" ? arg === "on" : DynamicWorkflows.sessionValue(current.metadata),
        })
        const status = `${refusal}Dynamic workflows: ${after.on ? "on" : "off"} (${after.reason}).${
          after.on
            ? " Build and Dev-Cycle plan the work and dispatch subagents to do it; the main agent doesn't edit, write or run commands itself."
            : " The main agent does the work itself; subagents stay available."
        }`
        return yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: input.model ? Provider.parseModel(input.model) : yield* currentModel(input.sessionID),
          agent: input.agent,
          parts: [{ type: "text", text: `/workflows${arg ? " " + arg : ""}\n\n${status}` }],
          noReply: true,
        })
      }

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      // XCOD-219: under a locked model a command's own `model` (or its agent's) is ignored, like an
      // agent's own model is. A model the caller asked for still goes through, to be refused.
      const commandLock = ConfigPolicy.lockedModel(yield* config.get(), agentName)
      // XCOD-254: in a Claude Code / Codex session Lunos expands the command and the tool answers;
      // no Lunos model is involved (as in the prompt loop), so none is looked up or required.
      const external = ExternalSession.of(yield* sessions.get(input.sessionID).pipe(Effect.orDie))
      const taskModel = yield* Effect.gen(function* () {
        if (external) return ExternalSession.model(external.tool)
        if (commandLock) return Provider.parseModel(input.model ?? commandLock.model)
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      if (!external) yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      // Every skill is promoted to a slash command (Command.state), but that table is
      // built once per instance with no agent in scope, while skill permissions are
      // per-agent. The model-facing list already filters via Skill.available(agent);
      // without this check the same denied skill stays typeable as a command. Listing
      // is not enforcement, so enforce here, at invocation.
      if (cmd.source === "skill" && Permission.evaluate("skill", cmd.name, agent.permission).action === "deny") {
        const error = new NamedError.Unknown({
          message: `Skill "${cmd.name}" is not permitted for agent "${agent.name}".`,
        })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      // A subtask would run a Lunos subagent; in an external session the text goes to the tool instead.
      const isSubtask = !external && ((agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true)
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
/**
 * XCOD-300: what this turn's context is made of, in tokens (estimated as Lunos does elsewhere), for
 * /context: the system prompt, instructions, Always resources, recalled memory, attachments, and
 * what project_resources_search and @mentions pulled in since the last user message.
 */
function contextBreakdown(input: {
  model: Provider.Model
  system: string[]
  instructions: string[]
  always: {
    included: { name: string; tokens: number }[]
    dropped: { name: string; tokens: number; reason: string }[]
    tokens: number
  }
  messages: SessionV1.WithParts[]
  mentioned: number
}) {
  const lastUser = input.messages.findLastIndex((message) => message.info.role === "user")
  const user = input.messages[lastUser]
  let memory = 0
  let attachments = 0
  for (const part of user?.parts ?? []) {
    if (part.type === "text" && part.synthetic && part.text.startsWith("<memory>")) memory += Token.estimate(part.text)
    if (part.type === "file") attachments += part.url.startsWith("data:") ? Math.round(part.url.length / 4) : 0
  }
  let searched = 0
  for (const message of input.messages.slice(lastUser + 1))
    for (const part of message.parts)
      if (part.type === "tool" && part.tool === "project_resources_search" && part.state.status === "completed")
        searched += Token.estimate(part.state.output)
  return {
    system: Token.estimate([...SystemPrompt.provider(input.model), ...input.system].join("\n")),
    instructions: Token.estimate(input.instructions.join("\n")),
    always: input.always.tokens,
    memory,
    attachments,
    searched,
    mentioned: input.mentioned,
    resources: input.always.included,
    dropped: input.always.dropped,
  }
}

const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    Memory.node,
    MemorySources.node,
    Resource.node,
    Skill.node,
    Question.node,
    BackgroundJob.node,
  ],
})

export * as SessionPrompt from "./prompt"
