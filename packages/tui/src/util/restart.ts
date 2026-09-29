import type { PromptInfo } from "../prompt/history"

/**
 * XCOD-129: `/restart`. The TUI decides *whether* to restart (asking first when a turn or a
 * background job is running) and hands this request to the command that started it, which stops
 * the worker (MCP, LSP, memory sidecar, local server) and launches Lunos again.
 */
export type RestartRequest = {
  /** The session to reopen. Undefined with `--fresh`, or when no session was open. */
  sessionID?: string
  fresh: boolean
  /** The unsent prompt, put back after the restart. */
  draft?: PromptInfo
  /** What "stop and restart" cancelled, listed in the banner afterwards. */
  cancelled: string[]
  /** Set when `/update` installed this version during the session: relaunch the new install. */
  upgraded?: string
}

/** What the relaunched process gets back from the one that restarted. */
export type Restarted = {
  /** The version that ran before the restart. */
  from: string
  fresh: boolean
  draft?: PromptInfo
  cancelled: string[]
  /** Set in attach mode: the server this client was attached to, which kept running. */
  attach?: string
}

/** What the TUI's host passes in to offer `/restart`. Without it the command isn't offered. */
export type RestartHost = {
  /** Set in `lunos attach`: only this client restarts; the server keeps running. */
  attach?: string
  request: (request: RestartRequest) => void
}

/**
 * "Restarted — Lunos 1.18.91", or "Restarted — Lunos 1.18.90 → 1.18.91" after an update. Attach
 * mode says only the client restarted, and "stop and restart" lists what it cancelled.
 */
export function restartBanner(input: Restarted, version: string) {
  const label = (value: string) => (value === "local" ? "dev (local build)" : value)
  const head =
    input.from && input.from !== version
      ? `Restarted — Lunos ${label(input.from)} → ${label(version)}`
      : `Restarted — Lunos ${label(version)}`
  const lines = [head]
  if (input.attach) lines.push(`Only this client restarted; the server at ${input.attach} kept running.`)
  if (input.cancelled.length) lines.push(`Cancelled: ${input.cancelled.join(", ")}`)
  return lines.join("\n")
}

/** `/restart` and `/restart --fresh`, typed and submitted rather than picked from the list. */
export function parseRestartSlash(input: string): { fresh: boolean } | undefined {
  const match = input.trim().match(/^\/restart(?:\s+(--fresh))?$/)
  if (!match) return
  return { fresh: Boolean(match[1]) }
}

/** The prompt to keep. The `/restart` text that triggered the restart is not a draft. */
export function restartDraft(prompt: PromptInfo | undefined): PromptInfo | undefined {
  if (!prompt) return
  if (!prompt.input.trim() && prompt.parts.length === 0) return
  if (prompt.input.trim().startsWith("/restart")) return
  return JSON.parse(JSON.stringify(prompt)) as PromptInfo
}

export type RestartChoice = "wait" | "stop" | "cancel"

/** Why the restart has to ask first, or undefined when nothing is running. */
export function restartBusyMessage(input: { busySessions: number; runningJobs: string[] }) {
  const parts: string[] = []
  if (input.busySessions > 0) parts.push(input.busySessions === 1 ? "The agent is mid-turn" : "Agents are mid-turn")
  if (input.runningJobs.length)
    parts.push(
      `${input.runningJobs.length} background ${input.runningJobs.length === 1 ? "job is" : "jobs are"} running`,
    )
  if (!parts.length) return
  return `${parts.join(", and ")}. Restarting now would cut ${parts.length > 1 || input.runningJobs.length > 1 ? "them" : "it"} off.`
}
