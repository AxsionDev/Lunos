import { describe, expect, test } from "bun:test"
import { animationsEnabled, prefersReducedMotion } from "../../src/util/motion"

describe("reduced motion (XCOD-107)", () => {
  test("NO_COLOR (non-empty) and TERM=dumb prefer reduced motion", () => {
    expect(prefersReducedMotion({ NO_COLOR: "1" })).toBe(true)
    expect(prefersReducedMotion({ NO_COLOR: "" })).toBe(false)
    expect(prefersReducedMotion({ TERM: "dumb" })).toBe(true)
    expect(prefersReducedMotion({ TERM: "xterm-256color" })).toBe(false)
  })

  test("reduced_motion: true wins over the in-app toggle", () => {
    expect(animationsEnabled(true, true, {})).toBe(false)
  })

  test("the environment only sets the default; the toggle still decides", () => {
    expect(animationsEnabled(undefined, undefined, { NO_COLOR: "1" })).toBe(false)
    expect(animationsEnabled(undefined, true, { NO_COLOR: "1" })).toBe(true)
    expect(animationsEnabled(undefined, undefined, {})).toBe(true)
    expect(animationsEnabled(undefined, false, {})).toBe(false)
  })

  test("reduced_motion: false turns them on even under NO_COLOR, unless toggled off", () => {
    expect(animationsEnabled(false, undefined, { NO_COLOR: "1" })).toBe(true)
    expect(animationsEnabled(false, false, { NO_COLOR: "1" })).toBe(false)
  })
})
