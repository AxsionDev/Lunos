export * as ExternalCodex from "./codex"

import { spawn, type ChildProcess } from "child_process"
import { createInterface } from "readline"
import { ExternalDetect } from "./detect"
import type { ExternalClaude } from "./claude"

/**
 * XCOD-204: drive the user's own Codex CLI through `codex app-server`, its JSON-RPC protocol
 * over stdio. Unlike `codex exec`, the app server sends each approval it needs to the client
 * (`item/fileChange/requestApproval`, `item/commandExecution/requestApproval`), so Lunos answers
 * them. Recorded from Codex 0.160.1 into test/external/fixtures/codex-app-server.jsonl:
 *
 *   host → initialize { clientInfo }  ·  initialized
 *   host → thread/start { cwd, model?, approvalPolicy, sandbox }  (or thread/resume { threadId })
 *   host → turn/start { threadId, input: [{ type: "text", text }] }
 *   tool → item/started / item/completed / thread/tokenUsage/updated / turn/completed
 *   tool → item/…/requestApproval (a request, with an id)   host → { id, result: { decision } }
 *
 * The app server is marked experimental by OpenAI; `lunos external list` reports the version.
 * Codex reports tokens, not money, so a session's cost is "not reported".
 */

/** Safe default: read-only, and ask for anything not known safe, so every edit and command asks. */
export const SAFE_SANDBOX = "read-only"
export const SAFE_APPROVAL = "untrusted"
const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"]
const APPROVALS = ["untrusted", "on-request", "never"]
/** Settings that skip approval or the sandbox. Only used when given explicitly for one run. */
export const UNSAFE = new Set(["danger-full-access", "never"])

export type Event = ExternalClaude.Event
export type PermissionRequest = ExternalClaude.PermissionRequest
export type PermissionDecision = ExternalClaude.PermissionDecision

export interface Options {
  cwd: string
  prompt: string
  /** A thread id to continue. */
  resume?: string
  model?: string
  sandbox?: string
  approvalPolicy?: string
  allowUnsafe?: boolean
  executable?: string
  ask: (request: PermissionRequest) => Promise<PermissionDecision>
  onEvent?: (event: Event) => void
}

export class UnsafeModeError extends Error {
  override name = "ExternalUnsafeMode"
}

/** The thread settings to send, after checking them. */
export function settings(options: Pick<Options, "sandbox" | "approvalPolicy" | "allowUnsafe">) {
  const sandbox = options.sandbox ?? SAFE_SANDBOX
  const approvalPolicy = options.approvalPolicy ?? SAFE_APPROVAL
  if (!SANDBOXES.includes(sandbox)) throw new Error(`"${sandbox}" isn't a Codex sandbox (${SANDBOXES.join(", ")})`)
  if (!APPROVALS.includes(approvalPolicy))
    throw new Error(`"${approvalPolicy}" isn't a Codex approval policy (${APPROVALS.join(", ")})`)
  for (const value of [sandbox, approvalPolicy])
    if (UNSAFE.has(value) && !options.allowUnsafe)
      throw new UnsafeModeError(
        `"${value}" skips Codex's approvals or sandbox. Pass it explicitly for this run (--permission-mode ${value} --unsafe) if you mean it.`,
      )
  return { sandbox, approvalPolicy }
}

const APPROVAL_METHODS: Record<string, string> = {
  "item/fileChange/requestApproval": "FileChange",
  "item/commandExecution/requestApproval": "Bash",
  "item/permissions/requestApproval": "Permissions",
}

export interface Running {
  child: ChildProcess
  done: Promise<Extract<Event, { type: "result" }> | Extract<Event, { type: "error" }>>
  stop: () => void
}

export function start(options: Options): Running {
  const executable = options.executable ?? ExternalDetect.locate("codex")
  if (!executable) throw new Error(`Codex CLI isn't installed. ${ExternalDetect.TOOLS.codex.install}`)
  const thread = settings(options)
  if (options.resume !== undefined && !/^[A-Za-z0-9_-]+$/.test(options.resume))
    throw new Error(`"${options.resume}" isn't a Codex thread id`)
  const cmd = ExternalDetect.command(executable, ["app-server"])
  const child = spawn(cmd.file, cmd.args, {
    cwd: options.cwd,
    shell: cmd.shell,
    env: ExternalDetect.environment(),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => (stderr += chunk))
  const write = (message: unknown) => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n")
  }
  let nextID = 0
  const waiting = new Map<number, (message: any) => void>()
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextID
      waiting.set(id, (message) =>
        message.error ? reject(new Error(message.error.message ?? method)) : resolve(message.result),
      )
      write({ id, method, params })
    })

  // Items in flight, so an approval request can say what it's for (the request only names the item).
  const items = new Map<string, any>()
  let threadID = options.resume ?? ""
  let turnID = ""
  let lastText = ""
  let tokens: number | undefined
  const denied: { tool: string; id: string }[] = []

  const done = new Promise<Extract<Event, { type: "result" }> | Extract<Event, { type: "error" }>>((resolve) => {
    let settled = false
    const finish = (event: Extract<Event, { type: "result" }> | Extract<Event, { type: "error" }>) => {
      if (settled) return
      settled = true
      options.onEvent?.(event)
      child.stdin?.end()
      resolve(event)
    }

    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      // A response to one of our requests.
      if (message.id !== undefined && !message.method) {
        const handler = waiting.get(message.id)
        waiting.delete(message.id)
        handler?.(message)
        return
      }
      const params = message.params ?? {}
      // A request from Codex: an approval.
      if (message.id !== undefined && APPROVAL_METHODS[message.method]) {
        const item = items.get(params.itemId) ?? {}
        const tool = APPROVAL_METHODS[message.method]
        const input: Record<string, unknown> =
          tool === "Bash"
            ? { command: params.command ?? item.command }
            : { file_path: item.changes?.map((change: any) => change.path).join(", "), changes: item.changes }
        const permission: PermissionRequest = {
          requestID: String(message.id),
          tool,
          input,
          description: params.reason ?? undefined,
          toolUseID: params.itemId,
        }
        void options
          .ask(permission)
          .catch((error: unknown) => ({ allow: false as const, message: String(error) }))
          .then((decision) => {
            if (!decision.allow) denied.push({ tool, id: params.itemId })
            write({ id: message.id, result: { decision: decision.allow ? "accept" : "decline" } })
          })
        return
      }
      if (message.id !== undefined) {
        // Any other request we don't handle: refuse it rather than leave Codex waiting.
        write({ id: message.id, error: { code: -32601, message: `Lunos doesn't handle ${message.method}` } })
        return
      }
      switch (message.method) {
        case "item/started": {
          const item = params.item ?? {}
          items.set(item.id, item)
          if (item.type === "commandExecution")
            options.onEvent?.({ type: "tool", id: item.id, name: "Bash", input: { command: item.command } })
          if (item.type === "fileChange")
            options.onEvent?.({ type: "tool", id: item.id, name: "FileChange", input: { changes: item.changes } })
          return
        }
        case "item/completed": {
          const item = params.item ?? {}
          items.set(item.id, item)
          if (item.type === "agentMessage" && item.text) {
            lastText = item.text
            options.onEvent?.({ type: "text", text: item.text })
          }
          if (item.type === "commandExecution" || item.type === "fileChange")
            options.onEvent?.({
              type: "tool_result",
              id: item.id,
              isError: item.status !== "completed",
              output: String(item.aggregatedOutput ?? item.status ?? ""),
            })
          return
        }
        case "thread/tokenUsage/updated":
          tokens = params.tokenUsage?.total?.totalTokens ?? tokens
          return
        case "turn/completed": {
          const turn = params.turn ?? {}
          finish({
            type: "result",
            ok: turn.status === "completed",
            subtype: turn.status ?? "unknown",
            text: lastText || (turn.error?.message ?? ""),
            sessionID: threadID,
            costUSD: undefined,
            turns: 1,
            tokens,
            denied,
          })
          return
        }
      }
    })
    child.on("error", (error) => finish({ type: "error", message: error.message }))
    child.on("close", (code) =>
      finish({
        type: "error",
        message: `Codex exited (${code ?? "signal"}) without finishing the turn${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`,
      }),
    )

    void (async () => {
      try {
        await request("initialize", { clientInfo: { name: "lunos", version: "1" } })
        write({ method: "initialized" })
        const common = { cwd: options.cwd, ...thread, ...(options.model ? { model: options.model } : {}) }
        const started = options.resume
          ? await request("thread/resume", { threadId: options.resume, ...common })
          : await request("thread/start", common)
        threadID = started?.thread?.id ?? threadID
        options.onEvent?.({ type: "init", sessionID: threadID, model: started?.model, tools: [], commands: [] })
        const turn = await request("turn/start", {
          threadId: threadID,
          input: [{ type: "text", text: options.prompt }],
        })
        turnID = turn?.turn?.id ?? ""
      } catch (error) {
        finish({
          type: "error",
          message: `Codex refused the session: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    })()
  })

  return {
    child,
    done,
    stop: () => {
      if (threadID && turnID)
        write({ id: ++nextID, method: "turn/interrupt", params: { threadId: threadID, turnId: turnID } })
      setTimeout(() => child.kill("SIGINT"), 2000).unref?.()
    },
  }
}
