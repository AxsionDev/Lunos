import { afterEach, describe, expect, test } from "bun:test"
import { RunBudget } from "../../src/agent/run-budget"

describe("RunBudget (XCOD-211)", () => {
  afterEach(() => RunBudget.reset())

  test("allows exactly the step limit, then refuses", () => {
    const env = { [RunBudget.STEPS]: "2" }
    expect([RunBudget.take(env), RunBudget.take(env), RunBudget.take(env)]).toEqual([true, true, false])
  })

  test("no step starts once spend has passed the limit; the step that reaches it isn't refused", () => {
    const env = { [RunBudget.COST]: "1" }
    expect(RunBudget.take(env)).toBe(true)
    RunBudget.spend(1)
    expect(RunBudget.take(env)).toBe(true)
    RunBudget.spend(0.5)
    expect(RunBudget.take(env)).toBe(false)
  })

  test("no budget, or one that isn't a positive number, never refuses", () => {
    RunBudget.spend(100)
    for (const value of [undefined, "", "0", "-1", "lots"])
      for (let i = 0; i < 5; i++)
        expect(RunBudget.take({ [RunBudget.STEPS]: value, [RunBudget.COST]: value })).toBe(true)
  })
})
