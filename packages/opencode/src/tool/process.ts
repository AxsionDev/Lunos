import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { PositiveInt } from "@opencode-ai/core/schema"
import { BackgroundShell } from "./shell/background"

// XCOD-288: the agent's handle on the background commands it started with the shell tool
// (`background: true`). It only ever sees and touches its own session's processes.

export const ID = "process"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "output", "wait", "stop"]).annotate({
    description:
      "list: this session's background processes. output: a process's recent output. wait: wait for `url` to answer. stop: stop a process and everything it started.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "The background process ID (bg_...), as returned by the shell tool. Required except for list.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "For wait: a local URL (localhost, 127.0.0.1 or [::1]) that answers once the process is ready.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: `For wait: how long to wait in milliseconds (default ${BackgroundShell.READY_TIMEOUT_MS}, at most ${BackgroundShell.READY_TIMEOUT_MAX_MS}).`,
  }),
  lines: Schema.optional(PositiveInt).annotate({
    description: "For output: how many of the last lines to show (default 40).",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

const DESCRIPTION = `Manage the background commands you started with the shell tool's \`background: true\` (dev servers, watchers) in this session.

- list: every background process of this session, with its status.
- output: the recent output of one process (\`lines\`, default 40). The full output is in its log file, readable with the Read tool.
- wait: wait until \`url\` (localhost, 127.0.0.1 or [::1] only) answers with any HTTP response, the process exits, or \`timeout\` passes.
- stop: stop a process and everything it started. Stop what you started once you have checked it, unless the user asked to keep it running.

Background processes also stop when the session is deleted, when Lunos exits, and after ${BackgroundShell.LIFETIME_MS / 60_000} minutes.`

function age(ms: number) {
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`
}

function status(info: BackgroundShell.Info) {
  if (info.status === "running") return `running (pid ${info.pid}, up ${age(Date.now() - info.startedAt)})`
  if (info.status === "stopped") return "stopped"
  if (info.status === "expired") return `stopped after its ${age(info.expiresAt - info.startedAt)} lifetime`
  if (info.error) return `failed to start: ${info.error}`
  return info.signal ? `exited (signal ${info.signal})` : `exited with code ${info.exitCode}`
}

export function describeReady(result: BackgroundShell.ReadyResult, url: URL, timeoutMs: number) {
  const secs = (result.elapsedMs / 1000).toFixed(1)
  if (result.ready) return `Ready: ${url.href} answered HTTP ${result.status} after ${secs}s.`
  if (result.reason === "exited") return `NOT ready: the process exited before ${url.href} answered.`
  if (result.reason === "aborted") return `Stopped waiting for ${url.href}: aborted.`
  return `NOT ready: ${url.href} did not answer within ${Math.min(timeoutMs, BackgroundShell.READY_TIMEOUT_MAX_MS)} ms${result.lastError ? ` (last error: ${result.lastError})` : ""}.`
}

export function describeListening(listening: BackgroundShell.Listening) {
  if (!listening.checked) return `Listening addresses: ${listening.reason}.`
  if (listening.addresses.length === 0) return "Listening addresses: none found."
  const line = `Listening on: ${listening.addresses.join(", ")}.`
  if (listening.exposed.length === 0) return line
  return `${line}\nWARNING: ${listening.exposed.join(", ")} can be reached from other machines. Restart it bound to 127.0.0.1 (e.g. --host 127.0.0.1, or the framework's host option) before going further.`
}

/** The text the model sees about one background process. */
export function report(info: BackgroundShell.Info, extra: string[] = [], lines = 40) {
  const output = BackgroundShell.tail(info, lines)
  return [
    `Background process ${info.id}: ${status(info)}.`,
    `Command: ${info.command}`,
    `Log file: ${info.log}`,
    ...extra,
    "",
    output ? `Recent output:\n${output}` : "(no output yet)",
  ].join("\n")
}

function owned(id: string | undefined, sessionID: string) {
  if (!id) throw new Error("This action needs the background process `id`.")
  const info = BackgroundShell.get(id)
  if (!info || info.sessionID !== sessionID) throw new Error(`No background process ${id} in this session.`)
  return info
}

type Metadata = { id?: string; status?: BackgroundShell.Status; count?: number }

export const ProcessTool = Tool.define<typeof Parameters, Metadata, never>(
  ID,
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Parameters, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        if (params.action === "list") {
          const items = BackgroundShell.list(ctx.sessionID)
          return {
            title: "background processes",
            metadata: { count: items.length },
            output: items.length
              ? items.map((info) => `${info.id}: ${status(info)} — ${info.command}`).join("\n")
              : "No background processes in this session.",
          }
        }

        const info = owned(params.id, ctx.sessionID)

        if (params.action === "output") {
          return {
            title: `output of ${info.id}`,
            metadata: { id: info.id, status: info.status },
            output: report(info, [], params.lines ?? 40),
          }
        }

        if (params.action === "stop") {
          yield* Effect.promise(() => BackgroundShell.stop(info.id))
          return {
            title: `stop ${info.id}`,
            metadata: { id: info.id, status: info.status },
            output: report(info),
          }
        }

        if (!params.url) throw new Error("wait needs the `url` to check.")
        const url = BackgroundShell.parseReadyUrl(params.url)
        const timeout = params.timeout ?? BackgroundShell.READY_TIMEOUT_MS
        const ready = yield* Effect.promise(() => BackgroundShell.waitReady(info, url, timeout, ctx.abort))
        const extra = [describeReady(ready, url, timeout)]
        if (ready.ready) extra.push(describeListening(BackgroundShell.listening(info)))
        return {
          title: `wait for ${url.href}`,
          metadata: { id: info.id, status: info.status },
          output: report(info, extra),
        }
      }),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
