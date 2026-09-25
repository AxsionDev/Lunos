import { describe, expect, test } from "bun:test"
import { createDoublePress, createSoftRejects, formatLateAnswer, isDismissedQuestion } from "../../src/util/dismiss"

function fakeTimers() {
  let now = 0
  const queue: { at: number; fn: () => void; id: number }[] = []
  let next = 0
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = next++
      queue.push({ at: now + ms, fn, id })
      return id
    },
    cancel: (handle: unknown) => {
      const index = queue.findIndex((item) => item.id === handle)
      if (index !== -1) queue.splice(index, 1)
    },
    advance(ms: number) {
      now += ms
      for (const item of queue.filter((item) => item.at <= now)) {
        queue.splice(queue.indexOf(item), 1)
        item.fn()
      }
    },
  }
}

describe("createDoublePress", () => {
  test("the first press only arms; a second within the window confirms", () => {
    const timers = fakeTimers()
    const guard = createDoublePress(() => 2000, timers)
    expect(guard.press()).toBe("armed")
    timers.advance(1500)
    expect(guard.press()).toBe("confirmed")
  })

  test("a second press after the window arms again instead of confirming", () => {
    const timers = fakeTimers()
    const guard = createDoublePress(() => 2000, timers)
    guard.press()
    timers.advance(2500)
    expect(guard.press()).toBe("armed")
  })

  test("a window of 0 confirms on the first press, as before the guard", () => {
    expect(createDoublePress(() => 0, fakeTimers()).press()).toBe("confirmed")
  })

  test("reset forgets the first press", () => {
    const guard = createDoublePress(() => 2000, fakeTimers())
    guard.press()
    guard.reset()
    expect(guard.press()).toBe("armed")
  })
})

describe("createSoftRejects", () => {
  const setup = (window = 5000) => {
    const timers = fakeTimers()
    const sent: [string, string][] = []
    const rejects = createSoftRejects<string>({ window: () => window, send: (id, v) => sent.push([id, v]), timers })
    return { timers, sent, rejects }
  }

  test("sends nothing during the window, then sends once", () => {
    const { timers, sent, rejects } = setup()
    rejects.dismiss("q1", "draft")
    timers.advance(4999)
    expect(sent).toEqual([])
    timers.advance(1)
    expect(sent).toEqual([["q1", "draft"]])
    timers.advance(10_000)
    expect(sent).toHaveLength(1)
  })

  test("undo within the window returns the draft and never sends", () => {
    const { timers, sent, rejects } = setup()
    rejects.dismiss("q1", "draft")
    expect(rejects.undo()).toEqual({ id: "q1", value: "draft" })
    timers.advance(10_000)
    expect(sent).toEqual([])
    expect(rejects.undo()).toBeUndefined()
  })

  test("undo takes the most recent dismissal", () => {
    const { rejects } = setup()
    rejects.dismiss("q1", "a")
    rejects.dismiss("q2", "b")
    expect(rejects.undo()?.id).toBe("q2")
  })

  test("flush sends everything still held, so a closed session never leaves the agent waiting", () => {
    const { timers, sent, rejects } = setup()
    rejects.dismiss("q1", "a")
    rejects.dismiss("q2", "b")
    rejects.flush()
    expect(sent).toEqual([
      ["q1", "a"],
      ["q2", "b"],
    ])
    timers.advance(10_000)
    expect(sent).toHaveLength(2)
    expect(rejects.size).toBe(0)
  })

  test("a window of 0 sends at once, as before", () => {
    const { sent, rejects } = setup(0)
    rejects.dismiss("q1", "a")
    expect(sent).toEqual([["q1", "a"]])
    expect(rejects.undo()).toBeUndefined()
  })
})

describe("isDismissedQuestion", () => {
  const part = (state: { status: string; error?: string }, tool = "question") => ({ type: "tool", tool, state })

  test("matches a question the user dismissed", () => {
    expect(isDismissedQuestion(part({ status: "error", error: "Error: The user dismissed this question" }))).toBe(true)
    expect(isDismissedQuestion(part({ status: "error", error: "QuestionRejectedError" }))).toBe(true)
  })

  test("ignores answered questions, other failures and other tools", () => {
    expect(isDismissedQuestion(part({ status: "completed" }))).toBe(false)
    expect(isDismissedQuestion(part({ status: "error", error: "Tool execution aborted" }))).toBe(false)
    expect(isDismissedQuestion(part({ status: "error", error: "QuestionRejectedError" }, "bash"))).toBe(false)
  })
})

describe("formatLateAnswer", () => {
  test("names each question by its header, one line each", () => {
    const questions = [
      { header: "Colour", question: "Colour?" },
      { header: "Name", question: "Name?" },
    ]
    expect(formatLateAnswer(questions, [["Blue", "Green"], []])).toBe(
      'Answer to your earlier question "Colour": Blue, Green\nAnswer to your earlier question "Name": (no answer)',
    )
  })
})
