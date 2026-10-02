import { describe, expect, test } from "bun:test"
import { formatCost } from "../../src/cli/cmd/stats"

// XCOD-169: Total Cost showed $0.00 beside per-model costs of $0.0001 and $0.0009.
describe("lunos stats cost", () => {
  test("a total under a cent keeps four decimals, as the per-model rows do", () => {
    expect(formatCost(0.0001 + 0.0009)).toBe("$0.0010")
    expect(formatCost(0.0001)).toBe("$0.0001")
  })

  test("a cent or more, and nothing at all, use two", () => {
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(0.01)).toBe("$0.01")
    expect(formatCost(1.23456)).toBe("$1.23")
  })
})
