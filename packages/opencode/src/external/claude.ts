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
 *   tool → { type: "control_response", response: { subtype: "success", request_id, response: { commands, models, … } } }
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
  | {
      type: "init"
      sessionID: string
      model?: string
      tools: string[]
      commands: string[]
      /** XCOD-254: the MCP servers the tool reports at start, with their state ("connected", "failed", …). */
      mcp?: { name: string; status: string }[]
      /** XCOD-285: the permission mode the tool says it runs in (`permissionMode` on its init line). */
      permissionMode?: string
      /** XCOD-285: its /commands with what it says about them (initialize's `commands`), when it lists them. */
      commandInfo?: CommandInfo[]
    }
  /** XCOD-285: the tool changed its permission mode mid-turn (its `status` line after `set_permission_mode`). */
  | { type: "mode"; mode: string }
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
      /** Tokens the tool reported, when it reports tokens rather than money (Codex). */
      tokens?: number
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
  /**
   * XCOD-285: what the tool offers to stop asking for this (Claude Code's `permission_suggestions`:
   * `addRules`, `setMode`, `addDirectories`, …), as it sent them. Its "Yes, and don't ask again" choice.
   */
  suggestions?: Suggestion[]
  /** XCOD-285: the decisions the tool accepts for this request (Codex's approval decisions), in its order. */
  decisions?: string[]
}

/** XCOD-285: one of Claude Code's `permission_suggestions` (the Agent SDK's `PermissionUpdate`). */
export type Suggestion = { type: string; destination?: string; [key: string]: unknown }

/** One of the tool's /commands, as initialize lists it. */
export interface CommandInfo {
  name: string
  description?: string
  hint?: string
}

/**
 * `always`: the user chose the tool's "don't ask again" answer, so the tool is told to apply its own
 * suggestions (Claude Code) or approve for the session (Codex). A refusal with `interrupt` also ends
 * the tool's turn (Claude Code's `interrupt`, Codex's `cancel`); without, the tool carries on.
 */
export type PermissionDecision =
  | { allow: true; always?: boolean }
  | { allow: false; message: string; interrupt?: boolean }

/**
 * XCOD-285: Lunos policy on a call before the tool's own permission mode decides it, through the
 * PreToolUse hook Lunos registers at initialize. A deny rule refuses the call even where the tool
 * would allow it without asking (`acceptEdits`, `auto`); undefined leaves it to the tool.
 */
export type Policy = (call: {
  tool: string
  input: Record<string, unknown>
  toolUseID?: string
}) => Promise<{ deny: string } | undefined>

/** The hook callback id Lunos registers for its policy check. */
export const POLICY_HOOK = "lunos-policy"

export interface Options {
  cwd: string
  prompt: string
  resume?: string
  model?: string
  permissionMode?: string
  /** Allow an approval-skipping mode for this run. Without it, such a mode is refused. */
  allowUnsafe?: boolean
  executable?: string
  maxBudgetUSD?: number
  /** XCOD-254: a `--mcp-config` file carrying the Lunos bridge (only when `--help` lists the flag). */
  mcpConfig?: string
  ask: (request: PermissionRequest) => Promise<PermissionDecision>
  /** XCOD-285: Lunos policy, checked on every call before the tool's own permission mode. */
  policy?: Policy
  onEvent?: (event: Event) => void
}

/** A model name that is safe on a command line: an id or alias, like `opus` or `claude-opus-5-5[1m]`. */
export const MODEL_ID = /^[A-Za-z0-9._:\[\]/-]+$/

export class UnsafeModeError extends Error {
  override name = "ExternalUnsafeMode"
}

/** A path that is safe on a command line, also through a shell (Windows .cmd shims): no spaces or quotes. */
export const PATH_ARG = /^[A-Za-z0-9._:\\/~-]+$/

export function args(
  options: Pick<Options, "resume" | "model" | "permissionMode" | "allowUnsafe" | "maxBudgetUSD" | "mcpConfig">,
) {
  const mode = options.permissionMode ?? SAFE_DEFAULT
  if (!/^[A-Za-z]+$/.test(mode)) throw new Error(`"${mode}" isn't a Claude Code permission mode`)
  if (UNSAFE_MODES.has(mode) && !options.allowUnsafe)
    throw new UnsafeModeError(
      `Permission mode "${mode}" skips every approval. Pass it explicitly for this run (--permission-mode ${mode} --unsafe) if you mean it.`,
    )
  // Passed on the command line (through a shell on Windows), so only an id-shaped value.
  if (options.model !== undefined && !MODEL_ID.test(options.model))
    throw new Error(`"${options.model}" isn't a model name`)
  if (options.resume !== undefined && !/^[A-Za-z0-9_-]+$/.test(options.resume))
    throw new Error(`"${options.resume}" isn't a Claude Code session id`)
  if (options.mcpConfig !== undefined && !PATH_ARG.test(options.mcpConfig))
    throw new Error(`"${options.mcpConfig}" can't be passed to Claude Code safely`)
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
    ...(options.model ? ["--model", options.model] : []),
    ...(options.maxBudgetUSD !== undefined ? ["--max-budget-usd", String(options.maxBudgetUSD)] : []),
    ...(options.mcpConfig ? ["--mcp-config", options.mcpConfig] : []),
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
      ...(typeof raw.permissionMode === "string" ? { permissionMode: raw.permissionMode } : {}),
      ...(Array.isArray(raw.mcp_servers)
        ? {
            mcp: raw.mcp_servers.flatMap((item: any) =>
              typeof item?.name === "string" ? [{ name: item.name, status: String(item.status ?? "") }] : [],
            ),
          }
        : {}),
    })
  if (raw.type === "system" && raw.subtype === "status" && typeof raw.permissionMode === "string")
    events.push({ type: "mode", mode: raw.permissionMode })
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
        ...(Array.isArray(raw.request.permission_suggestions) && raw.request.permission_suggestions.length
          ? {
              suggestions: raw.request.permission_suggestions.filter(
                (item: unknown): item is Suggestion =>
                  !!item && typeof item === "object" && typeof (item as Suggestion).type === "string",
              ),
            }
          : {}),
      },
    }
  return { events, raw }
}

/**
 * XCOD-285: the suggestions to apply for "don't ask again", only for this session. Claude Code would
 * write one aimed at `userSettings` / `projectSettings` / `localSettings` into that settings file; Lunos
 * never has it change the user's files on its own, so every one is applied to the session instead.
 */
export function sessionOnly(suggestions: readonly Suggestion[] | undefined) {
  return (suggestions ?? []).map((item) => ({ ...item, destination: "session" }))
}

export function reply(request: PermissionRequest, decision: PermissionDecision) {
  const updates = decision.allow && decision.always ? sessionOnly(request.suggestions) : []
  const response = decision.allow
    ? { behavior: "allow", updatedInput: request.input, ...(updates.length ? { updatedPermissions: updates } : {}) }
    : { behavior: "deny", message: decision.message, ...(decision.interrupt ? { interrupt: true } : {}) }
  return { type: "control_response", response: { subtype: "success", request_id: request.requestID, response } }
}

/**
 * XCOD-285: the answer to the PreToolUse hook callback (`hook_callback`), as the Agent SDK's
 * `SyncHookJSONOutput`: a deny with its reason, or nothing, which leaves the call to the tool.
 */
export function hookReply(requestID: string, verdict: { deny: string } | undefined) {
  const response = verdict
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.deny,
        },
      }
    : {}
  return { type: "control_response", response: { subtype: "success", request_id: requestID, response } }
}

export interface Running {
  child: ChildProcess
  /** Resolves with the final result (or an error event if the tool exited without one). */
  done: Promise<Extract<Event, { type: "result" }> | Extract<Event, { type: "error" }>>
  stop: () => void
  /**
   * XCOD-285: change the permission mode of the running turn (Claude Code's `set_permission_mode`),
   * as Shift+Tab does in the tool. Absent where the tool can't change it mid-turn.
   */
  setMode?: (mode: string) => void
}

/** One of the tool's models, as `/models` lists it in an external session (XCOD-254). */
export interface Model {
  /** What `--model` (or Codex's `model`) takes. */
  id: string
  name: string
  description?: string
  /** The model the tool uses when none is chosen. */
  default?: boolean
}

/**
 * XCOD-254: Claude Code's model aliases, for when it doesn't list its models (an older release, or
 * the probe failing). Aliases rather than full ids, so they keep naming the current model.
 */
export const FALLBACK_MODELS: Model[] = [
  { id: "opus", name: "Opus", description: "Claude Code's alias for the latest Opus" },
  { id: "sonnet", name: "Sonnet", description: "Claude Code's alias for the latest Sonnet" },
  { id: "haiku", name: "Haiku", description: "Claude Code's alias for the latest Haiku" },
]

/** The models in an `initialize` response (`response.models`: `{ value, displayName, description }`). */
export function parseModels(response: unknown): Model[] {
  const list = (response as { models?: unknown } | undefined)?.models
  if (!Array.isArray(list)) return []
  return list.flatMap((item: any) => {
    const id = item?.value ?? item?.id ?? item?.model
    if (typeof id !== "string" || !id) return []
    const name = item.displayName ?? item.display_name ?? id
    return [
      {
        id,
        name: String(name),
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
        ...(id === "default" ? { default: true } : {}),
      },
    ]
  })
}

/**
 * The tool's own /commands in an `initialize` response (`response.commands`: `{ name, description, … }`).
 * Claude Code 2.1.292 lists them only there; older releases list them as `slash_commands` on `init`.
 * Its internal ones (`__…`) and ones it describes as "(removed)" aren't for users, so they're left out.
 */
export function parseCommands(response: unknown): string[] {
  return parseCommandInfo(response).map((item) => item.name)
}

/** XCOD-285: the same commands with the description and argument hint the tool gives them. */
export function parseCommandInfo(response: unknown): CommandInfo[] {
  const list = (response as { commands?: unknown } | undefined)?.commands
  if (!Array.isArray(list)) return []
  return list.flatMap((item: any) => {
    if (typeof item?.name !== "string" || !item.name || item.name.startsWith("__")) return []
    if (typeof item.description === "string" && /^\s*\(removed\)/i.test(item.description)) return []
    return [
      {
        name: item.name,
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
        ...(typeof item.argumentHint === "string" && item.argumentHint ? { hint: item.argumentHint } : {}),
      },
    ]
  })
}

/**
 * XCOD-254: the models this Claude Code offers, from its answer to the host's `initialize` (as the
 * Agent SDK's `supportedModels()` reads them). No prompt is sent, so no model is called; the process
 * is stopped once it has answered. Empty when it doesn't list them in time.
 */
export function models(options: { executable: string; cwd: string; timeoutMs?: number }) {
  const cmd = ExternalDetect.command(options.executable, args({}))
  const child = spawn(cmd.file, cmd.args, {
    cwd: options.cwd,
    shell: cmd.shell,
    env: ExternalDetect.environment(),
    stdio: ["pipe", "pipe", "ignore"],
  })
  return new Promise<Model[]>((resolve) => {
    const finish = (result: Model[]) => {
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish([]), options.timeoutMs ?? 15_000)
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let raw: any
      try {
        raw = JSON.parse(line)
      } catch {
        return
      }
      if (raw.type === "control_response" && raw.response?.request_id === "lunos-models")
        finish(raw.response.subtype === "success" ? parseModels(raw.response.response) : [])
    })
    child.on("error", () => finish([]))
    child.on("close", () => finish([]))
    child.stdin?.on("error", () => undefined)
    child.stdin?.write(
      JSON.stringify({ type: "control_request", request_id: "lunos-models", request: { subtype: "initialize" } }) +
        "\n",
    )
  })
}

/**
 * The host's `initialize`. With a Lunos policy it registers one PreToolUse hook for every tool, so
 * Claude Code asks Lunos before its permission mode decides (2.1.304 answers `hooks_applied: true`).
 */
export function initialize(options: Pick<Options, "policy">) {
  return {
    subtype: "initialize",
    hooks: options.policy ? { PreToolUse: [{ hookCallbackIds: [POLICY_HOOK] }] } : null,
  }
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
    // Its /commands from the answer to initialize, merged into the `init` event with any it lists there.
    let commands: CommandInfo[] = []
    let initMode: string | undefined
    lines.on("line", (line) => {
      const parsed = parse(line)
      if (parsed.raw?.type === "control_response" && parsed.raw.response?.request_id === "lunos-init") {
        commands = parseCommandInfo(parsed.raw.response.response)
        const mode = parsed.raw.response.response?.current_permission_mode
        if (typeof mode === "string") initMode = mode
      }
      // XCOD-285: Lunos policy before the tool's own permission mode (the PreToolUse hook it registered).
      if (
        parsed.raw?.type === "control_request" &&
        parsed.raw.request?.subtype === "hook_callback" &&
        parsed.raw.request.callback_id === POLICY_HOOK
      ) {
        const requestID = parsed.raw.request_id
        const hook = parsed.raw.request.input ?? {}
        const call = {
          tool: String(hook.tool_name ?? ""),
          input: (hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {}) as Record<
            string,
            unknown
          >,
          toolUseID: hook.tool_use_id ?? parsed.raw.request.tool_use_id,
        }
        void (options.policy ? options.policy(call) : Promise.resolve(undefined))
          // A check that fails refuses the call, as a Lunos rule would: never a silent allow.
          .catch((error: unknown) => ({ deny: `Lunos couldn't check its policy: ${String(error)}` }))
          .then((verdict) => write(hookReply(requestID, verdict)))
      }
      for (const event of parsed.events) {
        if (event.type === "init") {
          event.commands = [...new Set([...commands.map((item) => item.name), ...event.commands])]
          if (commands.length) event.commandInfo = commands
          if (!event.permissionMode && initMode) event.permissionMode = initMode
        }
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
  write({ type: "control_request", request_id: "lunos-init", request: initialize(options) })
  write({ type: "user", message: { role: "user", content: options.prompt }, parent_tool_use_id: null })
  let modes = 0
  return {
    child,
    done,
    stop: () => child.kill("SIGINT"),
    setMode: (mode: string) => {
      if (!/^[A-Za-z]+$/.test(mode) || UNSAFE_MODES.has(mode)) return
      write({
        type: "control_request",
        request_id: `lunos-mode-${++modes}`,
        request: { subtype: "set_permission_mode", mode },
      })
    },
  }
}
