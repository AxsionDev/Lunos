/**
 * XCOD-287: background subagents are on by default, so `lunos run` can't stop at the first idle of
 * its session: the main agent may have launched subagents and ended its turn, and each one's result
 * wakes it again to integrate it. The run ends once the session is idle with none of its subagents
 * running, and has stayed so for `graceMs` (the gap between a subagent finishing and the session
 * being woken with its result).
 */
export type Settle = {
  /** The session is idle. */
  idle: boolean
  /** When the session was first seen idle with no subagent running, since it last worked. */
  drainedAt?: number
}

export const SETTLE_GRACE_MS = 5_000

export function create(): Settle {
  return { idle: false }
}

/** The session started working again (e.g. woken by a subagent's result). */
export function busy(): Settle {
  return { idle: false }
}

/**
 * The session went idle, or time passed while it was idle. `running` is how many of its subagents
 * are still running (queued ones included). `idleEvent` is the session's own idle event: with
 * nothing running then, the run ends at once, as it did before background subagents.
 */
export function check(
  state: Settle,
  input: { running: number; now: number; idleEvent: boolean; graceMs?: number },
): { state: Settle; end: boolean } {
  if (input.running > 0) return { state: { idle: true }, end: false }
  if (input.idleEvent && state.drainedAt === undefined && !state.idle) return { state: { idle: true }, end: true }
  if (!state.idle && !input.idleEvent) return { state, end: false }
  const drainedAt = state.drainedAt ?? input.now
  return {
    state: { idle: true, drainedAt },
    end: input.now - drainedAt >= (input.graceMs ?? SETTLE_GRACE_MS),
  }
}

export * as RunSettle from "./settle"
