export * as ExternalClaude from "./claude"

import { spawn, type ChildProcess } from "child_process"
import { createInterface } from "readline"
import { ExternalDetect } from "./detect"

/**
 * XCOD-204: drive the user's own Claude Code as a headless host.
 *
 * Lunos starts `claude -p` with stream-json in and out, and `--permission-prompt-tool stdio`, so
 * every approval Claude Code would ask for arrives here as a `can_use_tool` control request and
 * is answered by Lunos (its own approval UI, or the CLI's rule). The wire format was checked
 * against Claude Code 2.1.292 (test/external/fixtures/claude-stream.jsonl):
 *
 *   host → { type: "control_request", request_id, request: { subtype: "initialize" } }
 *   host → { type: "user", message: { role: "user", content }, parent_tool_use_id: null }
 *   tool → { type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name, input, … } }
 *   host → { type: "control_response", response: { subtype: "success", request_id, response: { behavior, … } } }
 *   tool → { type: "result", subtype, is_error, result, session_id, total_cost_usd, num_turns, permission_denials }
 *
 * The tool runs with the user's environment and login; Lunos never sees the credential.
 */

/** Modes that skip approval. Only used when the user passes them explicitly for one run. */
export const UNSAFE_MODES = new Set(["bypassPermissions"])
export const SAFE_DEFAULT = "default"

export type Event =
  | { type: "init"; sessionID: string; model?: string; tools: string[]; commands: string[] }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; output: string }
  | {
      type: "result"
      ok: boolean
      subtype: string
      text: string
      sessionID: string
      costUSD?: number
      turns?: number
      denied: { tool: string; id: string }[]
    }
  | { type: "error"; message: string }

export interface PermissionRequest {
  requestID: string
  tool: string
  input: Record<string, unknown>
  description?: string
  toolUseID?: string
}

export type PermissionDecision = { allow: true } | { allow: false; message: string; interrupt?: boolean }

export interface Options {
  cwd: string
  prompt: string
  resume?: string
  permissionMode?: string
  /** Allow an approval-skipping mode for this run. Without it, such a mode is refused. */
  allowUnsafe?: boolean
  executable?: string
  maxBudgetUSD?: number
  ask: (request: PermissionRequest) => Promise<PermissionDecision>
  onEvent?: (event: Event) => void
}

export class UnsafeModeError extends Error {
  override name = "ExternalUnsafeMode"
}

export function args(options: Pick<Options, "resume" | "permissionMode" | "allowUnsafe" | "maxBudgetUSD">) {
  const mode = options.permissionMode ?? SAFE_DEFAULT
  if (!/^[A-Za-z]+$/.test(mode)) throw new Error(`"${mode}" isn't a Claude Code permission mode`)
  if (UNSAFE_MODES.has(mode) && !options.allowUnsafe)
    throw new UnsafeModeError(
      `Permission mode "${mode}" skips every approval. Pass it explicitly for this run (--permission-mode ${mode} --unsafe) if you mean it.`,
    )
  // Passed on the command line (through a shell on Windows), so only an id-shaped value.
  if (options.resume !== undefined && !/^[A-Za-z0-9_-]+$/.test(options.resume))
    throw new Error(`"${options.resume}" isn't a Claude Code session id`)
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    mode,
    "--permission-prompt-tool",
    "stdio",
    ...(options.resume ? ["--resume", options.resume] : []),
    ...(options.maxBudgetUSD !== undefined ? ["--max-budget-usd", String(options.maxBudgetUSD)] : []),
  ]
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === "string" ? part : part?.type === "text" ? String(part.text ?? "") : ""))
      .join("")
  return ""
}

/** One stream-json line from Claude Code as Lunos events (several for a message with several blocks). */
export function parse(line: string): { events: Event[]; permission?: PermissionRequest; raw?: any } {
  let raw: any
  try {
    raw = JSON.parse(line)
  } catch {
    return { events: [] }
  }
  const events: Event[] = []
  if (raw.type === "system" && raw.subtype === "init")
    events.push({
      type: "init",
      sessionID: raw.session_id,
      model: raw.model,
      tools: raw.tools ?? [],
      commands: raw.slash_commands ?? [],
    })
  if (raw.type === "assistant")
    for (const block of raw.message?.content ?? []) {
      if (block.type === "text" && block.text) events.push({ type: "text", text: block.text })
      if (block.type === "tool_use") events.push({ type: "tool", id: block.id, name: block.name, input: block.input })
    }
  if (raw.type === "user" && Array.isArray(raw.message?.content))
    for (const block of raw.message.content)
      if (block.type === "tool_result")
        events.push({
          type: "tool_result",
          id: block.tool_use_id,
          isError: block.is_error === true,
          output: text(block.content),
        })
  if (raw.type === "result")
    events.push({
      type: "result",
      ok: raw.is_error !== true && raw.subtype === "success",
      subtype: raw.subtype,
      text: typeof raw.result === "string" ? raw.result : "",
      sessionID: raw.session_id,
      costUSD: raw.total_cost_usd,
      turns: raw.num_turns,
      denied: (raw.permission_denials ?? []).map((item: any) => ({ tool: item.tool_name, id: item.tool_use_id })),
    })
  if (raw.type === "control_request" && raw.request?.subtype === "can_use_tool")
    return {
      events,
      raw,
      permission: {
        requestID: raw.request_id,
        tool: raw.request.tool_name,
        input: raw.request.input ?? {},
        description: raw.request.description,
        toolUseID: raw.request.tool_use_id,
      },
    }
  return { events, raw }
}

export function reply(request: PermissionRequest, decision: PermissionDecision) {
  const response = decision.allow
    ? { behavior: "allow", updatedInput: request.input }
    : { behavior: "deny", message: decision.message, ...(decision.interrupt ? { interrupt: true } : {}) }
  return { type: "control_response", response: { subtype: "success", request_id: request.requestID, response } }
}

export interface Running {
  child: ChildProcess
  /** Resolves with the final result (or an error event if the tool exited without one). */
  done: Promise<Extract<Event, { type: "result" }> | Extract<Event, { type: "error" }>>
  stop: () => void
}

/** Start one turn. Ends when Claude Code reports its result; stdin is then closed, ending the process. */
export function start(options: Options): Running {
  const executable = options.executable ?? ExternalDetect.locate("claude")
  if (!executable) throw new Error(`Claude Code isn't installed. ${ExternalDetect.TOOLS.claude.install}`)
  const cmd = ExternalDetect.command(executable, args(options))
  const child = spawn(cmd.file, cmd.args, {
    cwd: options.cwd,
    shell: cmd.shell,
    env: ExternalDetect.environment(),
    stdio: ["pipe", "pipe", "pipe"],
  })
  const write = (message: unknown) => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n")
  }
  let stderr = ""
  child.stderr?.on("data", (chunk) => (stderr += chunk))
  const done = new Promise<Extract<Event, { type: "result" }> | Extract<Event, { type: "error" }>>((resolve) => {
    let settled = false
    const finish = (event: Extract<Event, { type: "result" }> | Extract<Event, { type: "error" }>) => {
      if (settled) return
      settled = true
      if (event.type === "error") options.onEvent?.(event)
      child.stdin?.end()
      resolve(event)
    }
    const lines = createInterface({ input: child.stdout! })
    lines.on("line", (line) => {
      const parsed = parse(line)
      for (const event of parsed.events) {
        if (event.type === "result") {
          options.onEvent?.(event)
          finish(event)
          continue
        }
        options.onEvent?.(event)
      }
      if (parsed.permission) {
        const request = parsed.permission
        void options
          .ask(request)
          .catch((error: unknown) => ({ allow: false as const, message: String(error) }))
          .then((decision) => write(reply(request, decision)))
      }
    })
    child.on("error", (error) => finish({ type: "error", message: error.message }))
    child.on("close", (code) =>
      finish({
        type: "error",
        message: `Claude Code exited (${code ?? "signal"}) without a result${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`,
      }),
    )
  })
  write({ type: "control_request", request_id: "lunos-init", request: { subtype: "initialize", hooks: null } })
  write({ type: "user", message: { role: "user", content: options.prompt }, parent_tool_use_id: null })
  return { child, done, stop: () => child.kill("SIGINT") }
}
