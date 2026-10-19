import { describe, expect, test } from "bun:test"
import { hasCustomMode, resolveMode } from "./local-mode"

describe("hasCustomMode", () => {
  test("detects explicitly custom modes", () => {
    expect(hasCustomMode([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified modes", () => {
    expect(hasCustomMode([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveMode", () => {
  const modes = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available mode", () => {
    expect(resolveMode(modes, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveMode(modes)?.name).toBe("build")
    expect(resolveMode(modes, "missing")?.name).toBe("build")
  })

  test("uses the first mode when build is unavailable", () => {
    expect(resolveMode([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})
