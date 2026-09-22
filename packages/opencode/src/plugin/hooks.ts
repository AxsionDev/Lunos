import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { ConfigHooks } from "@opencode-ai/core/config/hooks"

/**
 * Config-driven lifecycle hooks.
 *
 * Runs shell commands declared under `hooks` in config, so a user can wire up
 * lint-on-save or a pre-flight guard without authoring a plugin. This registers
 * against the existing `Plugin.trigger` dispatch rather than adding a second hook
 * path — config hooks and hand-written plugins share one execution route.
 *
 * `before` events treat a non-zero exit as a veto: the error propagates and aborts
 * the tool or command. `after` and session events are observational, so a failure
 * is logged and execution continues.
 */

type Entry = ConfigHooks.Entry
type Event = ConfigHooks.Event

const BLOCKING: ReadonlySet<string> = new Set(["tool.execute.before", "command.execute.before"])

/** Argument keys tools use for the path they act on, in the order we prefer them. */
const FILE_KEYS = ["filePath", "path", "file"] as const

export function filePathFrom(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  for (const key of FILE_KEYS) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

export function matches(entry: Entry, input: { tool?: string; file?: string }) {
  if (entry.disabled) return false
  const matcher = entry.matcher
  if (!matcher) return true
  if (matcher.tool !== undefined) {
    if (input.tool === undefined) return false
    if (!new Bun.Glob(matcher.tool).match(input.tool)) return false
  }
  if (matcher.file !== undefined) {
    if (input.file === undefined) return false
    if (!new Bun.Glob(matcher.file).match(input.file)) return false
  }
  return true
}

export async function runEntry(
  entry: Entry,
  event: Event,
  context: { tool?: string; file?: string; sessionID?: string },
) {
  const [command, ...args] = entry.command
  if (!command) return

  const proc = Bun.spawn([command, ...args], {
    env: {
      ...process.env,
      ...entry.environment,
      LUNOS_HOOK_EVENT: event,
      ...(context.tool ? { LUNOS_TOOL: context.tool } : {}),
      ...(context.file ? { LUNOS_FILE: context.file } : {}),
      ...(context.sessionID ? { LUNOS_SESSION_ID: context.sessionID } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(entry.timeout ?? ConfigHooks.DEFAULT_TIMEOUT),
  })

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (exitCode === 0) return

  const detail = stderr.trim()
  const message = `hook for ${event} failed (exit ${exitCode}): ${entry.command.join(" ")}${
    detail ? `\n${detail}` : ""
  }`

  // A `before` hook's non-zero exit is a veto — propagate so the caller aborts.
  if (BLOCKING.has(event)) throw new Error(message)
  console.error(`[hooks] ${message}`)
}

export async function ConfigHooksPlugin(_input: PluginInput): Promise<Hooks> {
  let configured: Partial<Record<Event, readonly Entry[]>> = {}

  const dispatch = async (event: Event, context: { tool?: string; file?: string; sessionID?: string }) => {
    const entries = configured[event]
    if (!entries?.length) return
    for (const entry of entries) {
      if (!matches(entry, context)) continue
      await runEntry(entry, event, context)
    }
  }

  return {
    config: async (config) => {
      configured = ((config as { hooks?: Partial<Record<Event, readonly Entry[]>> }).hooks ?? {}) as typeof configured
    },
    "tool.execute.before": async (input, output) => {
      await dispatch("tool.execute.before", {
        tool: input.tool,
        file: filePathFrom((output as { args?: unknown }).args),
        sessionID: input.sessionID,
      })
    },
    "tool.execute.after": async (input) => {
      await dispatch("tool.execute.after", {
        tool: input.tool,
        file: filePathFrom((input as { args?: unknown }).args),
        sessionID: input.sessionID,
      })
    },
    "command.execute.before": async (input) => {
      await dispatch("command.execute.before", { tool: (input as { command?: string }).command })
    },
    event: async ({ event }) => {
      if (!(event.type in configured)) return
      const sessionID = (event.properties as { sessionID?: string; info?: { id?: string } } | undefined)?.sessionID
      await dispatch(event.type as Event, { sessionID })
    },
  }
}
