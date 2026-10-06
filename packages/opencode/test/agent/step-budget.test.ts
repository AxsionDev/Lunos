import { afterEach, describe, expect, test } from "bun:test"
import { StepBudget } from "../../src/agent/step-budget"

describe("StepBudget (XCOD-211)", () => {
  afterEach(() => StepBudget.reset())

  test("allows exactly the limit, then refuses", () => {
    const env = { [StepBudget.ENV]: "2" }
    expect([StepBudget.take(env), StepBudget.take(env), StepBudget.take(env)]).toEqual([true, true, false])
  })

  test("no budget, or one that isn't a positive number, never refuses", () => {
    for (const value of [undefined, "", "0", "-1", "lots"])
      for (let i = 0; i < 5; i++) expect(StepBudget.take({ [StepBudget.ENV]: value })).toBe(true)
  })
})
