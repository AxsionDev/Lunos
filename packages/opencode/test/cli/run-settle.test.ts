import { describe, expect, test } from "bun:test"
import { RunSettle } from "../../src/cli/cmd/run/settle"

// XCOD-287: background subagents are on by default, so `lunos run` waits for them, and for the main
// agent to integrate their results, before it ends.
describe("lunos run settle", () => {
  test("ends at the session's idle when no subagent is running, as before", () => {
    expect(RunSettle.check(RunSettle.create(), { running: 0, now: 0, idleEvent: true }).end).toBe(true)
  })

  test("waits while subagents run, then for the session to integrate their results", () => {
    let state = RunSettle.create()
    let next = RunSettle.check(state, { running: 2, now: 0, idleEvent: true })
    expect(next.end).toBe(false)
    state = next.state
    next = RunSettle.check(state, { running: 1, now: 10_000, idleEvent: false })
    expect(next.end).toBe(false)
    state = next.state
    // The last one finished; its result wakes the session, which works and goes idle again.
    next = RunSettle.check(state, { running: 0, now: 20_000, idleEvent: false })
    expect(next.end).toBe(false)
    state = RunSettle.busy()
    next = RunSettle.check(state, { running: 0, now: 21_000, idleEvent: true })
    expect(next.end).toBe(true)
  })

  test("a session woken by a result that launches more subagents keeps the run going", () => {
    let state = RunSettle.check(RunSettle.create(), { running: 1, now: 0, idleEvent: true }).state
    state = RunSettle.busy()
    const next = RunSettle.check(state, { running: 2, now: 1_000, idleEvent: true })
    expect(next.end).toBe(false)
  })

  test("ends after the grace period if no result ever wakes the session", () => {
    let state = RunSettle.check(RunSettle.create(), { running: 1, now: 0, idleEvent: true }).state
    let next = RunSettle.check(state, { running: 0, now: 10_000, idleEvent: false })
    expect(next.end).toBe(false)
    state = next.state
    next = RunSettle.check(state, { running: 0, now: 10_000 + RunSettle.SETTLE_GRACE_MS - 1, idleEvent: false })
    expect(next.end).toBe(false)
    next = RunSettle.check(next.state, { running: 0, now: 10_000 + RunSettle.SETTLE_GRACE_MS, idleEvent: false })
    expect(next.end).toBe(true)
  })

  test("a heartbeat before the session ever went idle changes nothing", () => {
    const next = RunSettle.check(RunSettle.create(), { running: 0, now: 99_000, idleEvent: false })
    expect(next).toEqual({ state: { idle: false }, end: false })
  })
})
