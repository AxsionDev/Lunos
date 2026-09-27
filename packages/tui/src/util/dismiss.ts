// Guards against dismissing an agent's question by accident (XCOD-98). Both pieces are plain state
// machines over an injected clock and timer, so the TUI components stay thin and this stays testable.

type Timers = {
  now: () => number
  schedule: (fn: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
}

const realTimers: Timers = {
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The first press arms, a second press within `window` ms confirms. A window of 0 confirms on the
 * first press, which is the behaviour from before the guard existed.
 */
export function createDoublePress(window: () => number, timers: Pick<Timers, "now"> = realTimers) {
  let armedAt: number | undefined
  return {
    press(): "armed" | "confirmed" {
      const ms = window()
      const now = timers.now()
      if (ms <= 0 || (armedAt !== undefined && now - armedAt <= ms)) {
        armedAt = undefined
        return "confirmed"
      }
      armedAt = now
      return "armed"
    },
    /** Forget a pending first press, e.g. when that Esc was spent closing an answer edit. */
    reset() {
      armedAt = undefined
    },
  }
}

/**
 * Holds a rejection back for `window` ms so it can be undone. `send` runs once per id: when the
 * window passes, on `flush`, or at once for a window of 0. `undo` cancels it and hands back the value.
 */
export function createSoftRejects<T>(input: {
  window: () => number
  send: (id: string, value: T) => void
  timers?: Timers
}) {
  const timers = input.timers ?? realTimers
  const pending = new Map<string, { value: T; handle: unknown }>()
  const fire = (id: string) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    input.send(id, entry.value)
  }
  return {
    dismiss(id: string, value: T) {
      const ms = input.window()
      if (ms <= 0) return input.send(id, value)
      pending.set(id, { value, handle: timers.schedule(() => fire(id), ms) })
    },
    /** Cancels the most recent pending dismissal, or the given one, and returns what it held. */
    undo(id?: string): { id: string; value: T } | undefined {
      const key = id ?? [...pending.keys()].at(-1)
      const entry = key === undefined ? undefined : pending.get(key)
      if (key === undefined || !entry) return undefined
      timers.cancel(entry.handle)
      pending.delete(key)
      return { id: key, value: entry.value }
    },
    has(id: string) {
      return pending.has(id)
    },
    get size() {
      return pending.size
    },
    /** Sends every pending rejection now. Nothing may stay held once its owner goes away. */
    flush() {
      for (const [id, entry] of [...pending]) {
        timers.cancel(entry.handle)
        fire(id)
      }
    },
  }
}

/** A question tool call that ended because the user dismissed it. */
export function isDismissedQuestion(part: { type: string; tool?: string; state?: { status: string; error?: string } }) {
  if (part.type !== "tool" || part.tool !== "question" || part.state?.status !== "error") return false
  const error = part.state.error ?? ""
  return error.includes("QuestionRejectedError") || error.includes("dismissed this question")
}

/** The follow-up message that answers a question after its turn ended. One line per question. */
export function formatLateAnswer(
  questions: ReadonlyArray<{ header: string; question: string }>,
  answers: ReadonlyArray<ReadonlyArray<string> | undefined>,
) {
  return questions
    .map((q, i) => {
      const answer = answers[i]?.length ? answers[i]!.join(", ") : "(no answer)"
      return `Answer to your earlier question "${q.header}": ${answer}`
    })
    .join("\n")
}
