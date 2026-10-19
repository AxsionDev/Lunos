// XCOD-265: `lunos session archive --older-than`.
import { describe, expect, test } from "bun:test"
import { parseAge } from "../../src/cli/cmd/session"

describe("parseAge", () => {
  test("minutes, hours, days and weeks", () => {
    expect(parseAge("30m")).toBe(30 * 60_000)
    expect(parseAge("12h")).toBe(12 * 3_600_000)
    expect(parseAge("7d")).toBe(7 * 86_400_000)
    expect(parseAge("2w")).toBe(14 * 86_400_000)
  })

  test("anything else is refused, not guessed", () => {
    for (const value of ["7", "7x", "d", "-1d", "1.5d", ""]) expect(parseAge(value)).toBeUndefined()
  })
})
