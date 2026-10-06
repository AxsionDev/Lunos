export * as AgentUnattended from "./unattended"

import { spawn } from "node:child_process"
import type { AgentJobs } from "./jobs"
import { RunBudget } from "./run-budget"

/**
 * XCOD-211: one unattended run of an agent. It runs `lunos run --format json --unattended` as a
 * child process and watches its events:
 *
 * - **Nobody approves anything.** `--auto` is never passed (PO decision, 2026-10-05), and
 *   `--unattended` makes every permission prompt a refusal the agent is told about, so it can
 *   carry on without that action. Each refusal is in the report.
 * - **Hard limits.** Wall time, model spend and steps, the subagents' steps included. The child
 *   enforces them itself (see RunBudget): no step starts past the step or spend limit, and at the
 *   deadline it aborts the step in progress. Then it ends the run the normal way, so a sandboxed
 *   run hands back what the agent did (PO decision, 2026-10-06: a run that reaches a limit is a
 *   success with partial results). Signals are only the fallback for a child that doesn't stop
 *   by itself: they can't wind a run down on Windows, where kill() ends the process outright.
 */

export type Reason = "completed" | "failed" | "time" | "cost" | "steps"

export interface Report {
  agent: string
  job?: string
  status: "ok" | "failed"
  /** Why it ended: a limit is a success; the work done until then is handed back. */
  reason: Reason
  started: string
  finished: string
  seconds: number
  steps: number
  cost: number
  limits: AgentJobs.Limits
  sandbox: boolean
  session?: string
  /** Where a sandboxed run's results were handed back: a branch, or a patch file. */
  results?: string
  /** Permission prompts refused because nobody could answer them. */
  denied: { permission: string; patterns: string[] }[]
  /** Files the agent's edit tools changed (changes made through bash aren't seen here). */
  edited: string[]
  error?: string
  exitCode: number | null
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"])

export interface Spawn {
  file: string
  base: string[]
}

export async function run(input: {
  command: Spawn
  agent: string
  prompt: string
  cwd: string
  limits: AgentJobs.Limits
  sandbox: boolean
  job?: string
  env?: Record<string, string | undefined>
  /** How long the child gets to stop by itself once a limit is reached, in milliseconds. */
  windDown?: number
  /** Grace period between SIGINT and SIGKILL, in milliseconds. */
  grace?: number
  now?: () => number
}): Promise<Report> {
  const now = input.now ?? Date.now
  const start = now()
  const args = [
    ...input.command.base,
    "run",
    "--format",
    "json",
    "--unattended",
    "--agent",
    input.agent,
    input.sandbox ? "--sandbox" : "--no-sandbox",
    input.prompt,
  ]
  // stdin must not be an open pipe: `lunos run` would wait to read it.
  const child = spawn(input.command.file, args, {
    cwd: input.cwd,
    // The child enforces the limits: by the time we see a step finish, more may have begun.
    env: {
      ...process.env,
      ...input.env,
      [RunBudget.STEPS]: String(input.limits.steps),
      [RunBudget.COST]: String(input.limits.cost),
      [RunBudget.DEADLINE]: String(start + input.limits.time * 1000),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let steps = 0
  let cost = 0
  let session: string | undefined
  let reason: Reason | undefined
  let error: string | undefined
  const denied: Report["denied"] = []
  const edited = new Set<string>()
  let stderr = ""

  // A limit is reached: the child stops by itself and hands back its results. Only if it hasn't
  // exited after the wind-down is it interrupted, then killed, and the run counts as failed.
  let stuck = false
  let windDownTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const windDown = input.windDown ?? 120_000
  const stop = (why: Reason) => {
    if (reason) return
    reason = why
    windDownTimer = setTimeout(() => {
      stuck = true
      child.kill("SIGINT")
      killTimer = setTimeout(() => child.kill("SIGKILL"), input.grace ?? 10_000)
    }, windDown)
  }
  const timer = setTimeout(() => stop("time"), input.limits.time * 1000)

  let buffer = ""
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith("{")) continue
      let event: Record<string, any>
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      session ??= typeof event.sessionID === "string" ? event.sessionID : undefined
      if (event.type === "step_finish" || event.type === "subagent_step_finish") {
        steps++
        cost += typeof event.part?.cost === "number" ? event.part.cost : 0
        if (cost > input.limits.cost) stop("cost")
        else if (steps >= input.limits.steps) stop("steps")
      }
      if (event.type === "permission_rejected")
        denied.push({ permission: String(event.permission), patterns: (event.patterns as string[]) ?? [] })
      if (event.type === "tool_use" && EDIT_TOOLS.has(event.part?.tool)) {
        const file = event.part?.state?.input?.filePath
        if (typeof file === "string") edited.add(file)
      }
      if (event.type === "error") error ??= JSON.stringify(event.error)
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", (spawnError) => {
      error ??= spawnError.message
      resolve(null)
    })
    child.on("exit", (code) => resolve(code))
  })
  clearTimeout(timer)
  if (windDownTimer) clearTimeout(windDownTimer)
  if (killTimer) clearTimeout(killTimer)

  if (stuck) error = `didn't stop within ${Math.round(windDown / 1000)}s of reaching its ${reason} limit`
  // A limit reached is a success if the child then ended cleanly (results handed back); the reason
  // still says which limit. A child that had to be killed, or failed to hand back, failed.
  const ok = exitCode === 0 && !stuck && (reason !== undefined || !error)
  const final: Reason = reason ?? (ok ? "completed" : "failed")
  if (!ok && !error) error = stderr.trim().split("\n").slice(-5).join("\n") || `exit code ${exitCode}`
  const results = handedBack(stderr)
  const end = now()
  return {
    agent: input.agent,
    ...(input.job ? { job: input.job } : {}),
    status: ok ? "ok" : "failed",
    reason: final,
    started: new Date(start).toISOString(),
    finished: new Date(end).toISOString(),
    seconds: Math.round((end - start) / 100) / 10,
    steps,
    cost: Math.round(cost * 1e6) / 1e6,
    limits: input.limits,
    sandbox: input.sandbox,
    ...(session ? { session } : {}),
    ...(results ? { results } : {}),
    denied,
    edited: [...edited].sort(),
    ...(error ? { error } : {}),
    exitCode,
  }
}

/** The branch or patch a sandboxed run's results were handed back as, from its output. */
export function handedBack(output: string) {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "")
  return (
    plain.match(/results on branch (\S+)/)?.[1] ?? plain.match(/the agent's changes are in (\S+) \(git apply\)/)?.[1]
  )
}

/** "30m", "2h", "90s" or plain seconds, as seconds. */
export function duration(value: string) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/)
  if (!match) throw new Error(`"${value}" isn't a duration (e.g. 90s, 30m, 2h)`)
  const amount = Number(match[1])
  return Math.round(amount * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1))
}
