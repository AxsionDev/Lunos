import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Global } from "@opencode-ai/core/global"
import { SandboxConfig } from "./config"

// XCOD-301: quitting Lunos hands the results back in a detached helper (`lunos sandbox conclude
// <id>`), which writes where it is to <state>/sandbox/conclude/<id>.json. That file is what
// `lunos sandbox status <id>` shows, what `on_exit: "wait"` follows, what the next start waits on
// (a running one) or announces (a failed one), and what keeps `prune` from removing a sandbox whose
// results haven't been saved. Its own directory: everything in <state>/sandbox/*.json is metadata.

export type Step = {
  /** "Handing back results", "Removing container"… */
  label: string
  started: string
  finished?: string
  /** "3 files, 1 commit", "skipped: no changes"… */
  detail?: string
}

export type State = {
  id: string
  /** The project (or folder) the sandbox ran for, as in its metadata. */
  root: string
  state: "running" | "done" | "failed"
  /** The helper's; unset until it has started. */
  pid?: number
  started: string
  finished?: string
  steps: Step[]
  /** What it reports once done (the branch, the files…), as the foreground used to print it. */
  lines: string[]
  /** Why it failed. */
  reason?: string
  /** The helper's run log, with the full error (XCOD-280). */
  log?: { id: string; file: string }
  /** What became of the sandbox: destroyed, or kept (stopped). */
  outcome?: "destroyed" | "retained"
  /** How the session went and the policy it was concluded with, so a Retry does the same. */
  input?: { failed: boolean; label: string; policy: SandboxConfig.Resolved["on_finish"] }
}

/** How long a helper may take to start and say so before it counts as never started. */
export const SPAWN_GRACE = 60_000

export const dir = () => path.join(Global.Path.state, "sandbox", "conclude")
export const file = (id: string) => path.join(dir(), `${id}.json`)

/** Written whole, then renamed over the old one, so a reader never sees half a file. */
export function write(state: State) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const part = `${file(state.id)}.${process.pid}.part`
  fs.writeFileSync(part, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(part, file(state.id))
}

/** The file as it is, or undefined. A read that races a rename (EPERM on Windows) is tried again. */
export function read(id: string): State | undefined {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(file(id), "utf8")) as State
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    }
  }
  return undefined
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it's just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Where a helper is. A "running" one whose process has gone (the computer restarted, it was killed)
 * is failed from here on, and the file says so.
 */
export function current(id: string, now = Date.now()): State | undefined {
  const state = read(id)
  if (!state || state.state !== "running") return state
  const gone = state.pid === undefined ? now - Date.parse(state.started) > SPAWN_GRACE : !alive(state.pid)
  if (!gone) return state
  const failed: State = {
    ...state,
    state: "failed",
    finished: new Date(now).toISOString(),
    reason:
      state.pid === undefined
        ? "the background helper never started"
        : "the background helper stopped before it finished (was the computer restarted?)",
  }
  try {
    write(failed)
  } catch {}
  return failed
}

/** Every helper's state, newest first. */
export function all(): State[] {
  const names = (() => {
    try {
      return fs.readdirSync(dir())
    } catch {
      return [] as string[]
    }
  })()
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => current(name.slice(0, -".json".length)))
    .filter((item): item is State => item !== undefined)
    .sort((a, b) => b.started.localeCompare(a.started))
}

const real = (item: string) => {
  try {
    return fs.realpathSync(item)
  } catch {
    return path.resolve(item)
  }
}

/** Whether a helper is for the project at `directory` (its repository, or the folder itself). */
export function belongs(state: Pick<State, "root">, directory: string) {
  const places = [SandboxConfig.worktreeOf(directory), directory].map(real)
  return places.includes(real(state.root))
}

/** Helpers still running for this project. */
export const running = (directory: string) =>
  all().filter((item) => item.state === "running" && belongs(item, directory))

/** Whether a helper is working on this sandbox right now. */
export const busy = (id: string) => current(id)?.state === "running"

/**
 * Whether `prune` must leave this sandbox alone: its results are being handed back, or the handoff
 * failed and they're still only in it.
 */
export function held(id: string) {
  const state = current(id)
  return state?.state === "running" || state?.state === "failed"
}

/**
 * Sandboxes for this project whose results weren't saved, newest first: the failed helpers whose
 * sandbox still exists (one destroyed since has nothing left to save).
 */
export function unsaved(directory: string, exists: (id: string) => boolean) {
  return all().filter((item) => item.state === "failed" && belongs(item, directory) && exists(item.id))
}

/** How long a finished helper's state stays for `lunos sandbox status <id>`: as long as run logs do. */
export const KEEP = 14 * 86_400_000

/**
 * Remove what no one needs any more: finished helpers older than `keep`, and failed ones whose
 * sandbox has been destroyed since (nothing left to save). Run with `prune`. Returns the ids.
 */
export function tidy(exists: (id: string) => boolean, now = Date.now(), keep = KEEP) {
  const gone = all().filter(
    (item) =>
      (item.state === "done" && now - Date.parse(item.finished ?? item.started) > keep) ||
      (item.state === "failed" && !exists(item.id)),
  )
  for (const item of gone) fs.rmSync(file(item.id), { force: true })
  return gone.map((item) => item.id)
}

/**
 * Wait for this project's running helpers, so a new sandbox (or anything touching the results
 * branch) never overlaps one. `log` gets a line when the wait starts. Gives up after `timeout`.
 */
export async function settle(directory: string, log: (line: string) => void, timeout = 15 * 60_000) {
  const waiting = running(directory)
  if (!waiting.length) return []
  log(
    `waiting for sandbox ${waiting.map((item) => item.id).join(", ")} to finish saving its results (\`lunos sandbox status ${waiting[0].id}\`)`,
  )
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && waiting.some((item) => busy(item.id))) await sleep(250)
  return waiting.map((item) => current(item.id) ?? item)
}

/** Seconds, as the progress lines show them: "2.1 s". */
export function seconds(step: Pick<Step, "started" | "finished">, now = Date.now()) {
  const end = step.finished ? Date.parse(step.finished) : now
  return `${(Math.max(0, end - Date.parse(step.started)) / 1000).toFixed(1)} s`
}

/** One step as a progress line: "Handing back results… 3 files, 1 commit · 2.1 s". */
export function stepLine(step: Step, now = Date.now()) {
  return `${step.label}…${step.detail ? ` ${step.detail}` : ""} · ${seconds(step, now)}`
}

export * as SandboxConclude from "./conclude"
