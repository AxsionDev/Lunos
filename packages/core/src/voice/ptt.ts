export * as VoicePtt from "./ptt"

// XCOD-336: push-to-talk from key presses alone. Most terminals report no key releases, but a held
// key auto-repeats: presses that keep arriving mean "still held", and when they stop the key was
// released. A single press with no repeats is a tap, which toggles: record until the next press.
//
//   idle --press--> pending --repeat--> held --no press for GAP_MS--> stop
//                      \--no repeat within FIRST_REPEAT_MS--> toggled --press--> stop
//
// A terminal with key releases (kitty `repeated` / release events) gives the same answers faster.

/** Longest wait for the first auto-repeat (macOS's longest "delay until repeat" is ~2 s, default ~0.5 s). */
export const FIRST_REPEAT_MS = 700
/** A held key repeats every 30-100 ms by default; a longer silence means it was released. */
export const GAP_MS = 250

export type State = "idle" | "pending" | "held" | "toggled"
export type Action = "start" | "stop" | undefined

/**
 * `releases`: the input reports releases (a mouse button, a kitty terminal), so a long press waits
 * for its release instead of turning into a toggle when no auto-repeat arrives.
 */
export function create(options: { releases?: boolean } = {}) {
  const state = { mode: "idle" as State, started: 0, last: 0, quiet: 0 }

  // After a stop the key may still be down and about to auto-repeat (the first repeat comes up to
  // FIRST_REPEAT_MS later): those presses mustn't start a new recording.
  const stop = (now: number, quiet = GAP_MS): Action => {
    Object.assign(state, { mode: "idle", quiet: now + quiet })
    return "stop"
  }

  return {
    get mode() {
      return state.mode
    },
    /** A key press (or an auto-repeat of it). */
    press(now: number, repeated = false): Action {
      if (state.mode === "idle") {
        if (repeated || now < state.quiet) {
          state.quiet = Math.max(state.quiet, now + GAP_MS)
          return
        }
        Object.assign(state, { mode: "pending", started: now, last: now })
        return "start"
      }
      if (state.mode === "toggled") return repeated ? undefined : stop(now, FIRST_REPEAT_MS)
      // pending or held: another press while the first is fresh is the key repeating.
      state.last = now
      state.mode = "held"
      return
    },
    /** A key release, from terminals that report them. */
    release(now: number): Action {
      if (state.mode === "held") return stop(now)
      if (state.mode !== "pending") return
      if (now - state.started >= FIRST_REPEAT_MS) return stop(now)
      state.mode = "toggled"
      return
    },
    /** Called on a timer while recording. */
    tick(now: number): Action {
      if (state.mode === "held" && now - state.last > GAP_MS) return stop(now)
      if (state.mode === "pending" && !options.releases && now - state.started > FIRST_REPEAT_MS) state.mode = "toggled"
      return
    },
    /** Esc, an error, or the recording ending by itself. */
    reset() {
      state.mode = "idle"
    },
  }
}
