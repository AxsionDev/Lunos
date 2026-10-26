export * as StartupTrace from "./startup-trace"

import { isMainThread } from "node:worker_threads"

/**
 * The start-up phase timeline: what ran between process start and the first frame of the TUI, and
 * what ran behind it. Always recorded (a few dozen entries); printed only with LUNOS_STARTUP_TRACE=1
 * or by `lunos debug startup`. Times are milliseconds since this process started.
 */
export const ENV = "LUNOS_STARTUP_TRACE"

export type Phase = {
  name: string
  /** ms since process start */
  start: number
  /** ms; 0 for a point in time (a mark) */
  duration: number
  /** whether the first frame waited for it */
  blocking: boolean
  /** the server's worker thread, or this (the TUI's) thread */
  thread: "main" | "worker"
  /** still running when the timeline was read; `duration` is so far */
  running?: boolean
}

type Options = { blocking?: boolean }

const recorded: Phase[] = []
const open = new Set<Omit<Phase, "duration">>()
let frame: number | undefined
const frameWaiters = new Set<() => void>()

/**
 * The process's start in epoch ms. A worker shares the process but not `performance.timeOrigin`, so
 * the main thread passes its own down in the environment.
 */
const ORIGIN_ENV = "LUNOS_STARTUP_ORIGIN"
const thread: Phase["thread"] = isMainThread ? "main" : "worker"
const origin = (thread === "worker" && Number(process.env[ORIGIN_ENV])) || performance.timeOrigin

/** The environment entry a worker needs to report its phases on this process's clock. */
export function originEnv() {
  return { [ORIGIN_ENV]: String(origin) }
}

/**
 * LUNOS_STARTUP_TRACE=1 prints the timeline to stderr when the TUI exits; a path writes it there (as
 * JSON when it ends in .json).
 */
export function enabled() {
  const value = process.env[ENV]?.toLowerCase()
  return Boolean(value) && value !== "0" && value !== "false"
}

/** Where to write the timeline: a file, or undefined for stderr. */
export function target() {
  const value = process.env[ENV]
  if (!value || ["1", "true"].includes(value.toLowerCase())) return undefined
  return value
}

/** ms since process start */
export function now() {
  return performance.timeOrigin + performance.now() - origin
}

/** Starts a phase; call the returned function when it ends. */
export function begin(name: string, options: Options = {}) {
  const phase = { name, start: now(), blocking: options.blocking ?? true, thread }
  open.add(phase)
  return () => {
    if (!open.delete(phase)) return
    recorded.push({ ...phase, duration: now() - phase.start })
  }
}

/** Times `fn` as a phase. A phase runs on the first frame's path unless `blocking: false`. */
export async function span<T>(name: string, fn: () => T | Promise<T>, options: Options = {}): Promise<T> {
  const end = begin(name, options)
  try {
    return await fn()
  } finally {
    end()
  }
}

/** `span` for synchronous work. */
export function trace<T>(name: string, fn: () => T, options: Options = {}): T {
  const end = begin(name, options)
  try {
    return fn()
  } finally {
    end()
  }
}

/** A phase measured by the caller, e.g. from process start to the first line of the CLI. */
export function record(name: string, start: number, end = now(), options: Options = {}) {
  recorded.push({ name, start, duration: end - start, blocking: options.blocking ?? true, thread })
}

/** A point in time, e.g. "worker ready". */
export function mark(name: string, options: Options = {}) {
  recorded.push({ name, start: now(), duration: 0, blocking: options.blocking ?? false, thread })
}

/** Called once, when the TUI has drawn its first frame with the home screen (or Welcome) on it. */
export function firstFrame(name = "first frame") {
  if (frame !== undefined) return
  frame = now()
  recorded.push({ name, start: frame, duration: 0, blocking: true, thread })
  for (const resolve of frameWaiters) resolve()
  frameWaiters.clear()
}

/** ms from process start to the first frame, once it has been drawn. */
export function firstFrameAt() {
  return frame
}

export function waitFirstFrame() {
  if (frame !== undefined) return Promise.resolve()
  return new Promise<void>((resolve) => frameWaiters.add(resolve))
}

/** Phases recorded elsewhere (the server's worker), already on this process's clock. */
export function add(phases: readonly Phase[]) {
  recorded.push(...phases)
}

/**
 * The timeline so far, in start order. Stable: other features (per-run logs) read it. A phase that
 * ended after the first frame, or hasn't ended yet, never blocked it, whatever it was declared as.
 */
export function phases(): Phase[] {
  const at = now()
  const running = [...open].map((phase) => ({ ...phase, duration: at - phase.start, running: true }))
  return [...recorded, ...running]
    .map((phase) => ({
      ...phase,
      blocking:
        phase.blocking && !phase.running && (frame === undefined || phase.start + phase.duration <= frame + 0.5),
    }))
    .toSorted((a, b) => a.start - b.start)
}

const ms = (value: number) => value.toFixed(1).padStart(8)

/** The timeline as text: start, duration, whether it blocked the first frame, and the phase. */
export function format(list: readonly Phase[] = phases()) {
  const lines = [`${"start ms".padStart(8)} ${"took ms".padStart(8)}  blocks  phase`]
  for (const phase of list) {
    const name =
      (phase.thread === "worker" ? `[server] ${phase.name}` : phase.name) + (phase.running ? " (still running)" : "")
    lines.push(
      `${ms(phase.start)} ${phase.duration ? ms(phase.duration) : "".padStart(8)}  ${phase.blocking ? "yes   " : "no    "}  ${name}`,
    )
  }
  if (frame !== undefined) lines.push(`first frame at ${frame.toFixed(1)} ms`)
  return lines.join("\n")
}

/** The timeline for a file: JSON for a .json path, the text otherwise. */
export function serialize(file: string) {
  if (file.endsWith(".json")) return JSON.stringify({ firstFrame: frame, phases: phases() }, null, 2) + "\n"
  return format() + "\n"
}

/**
 * ms the first frame waited for, minus module loading (the CLI's modules, and every "import …"
 * phase): the work on the start path itself. What the start-up budget test holds down.
 */
export function startPathMs(list: readonly Phase[] = phases(), first = frame) {
  if (first === undefined) return undefined
  const loaded = list.find((phase) => phase.name === "load cli modules")
  const start = loaded ? loaded.start + loaded.duration : 0
  const imports = list
    .filter((phase) => phase.thread === "main" && phase.blocking && phase.name.startsWith("import "))
    .reduce((sum, phase) => sum + phase.duration, 0)
  return first - start - imports
}

/** Test-only: forget everything recorded. */
export function reset() {
  recorded.length = 0
  open.clear()
  frame = undefined
}
