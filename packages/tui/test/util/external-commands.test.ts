import { describe, expect, test } from "bun:test"
import { lunosCommand, lunosName, UNAVAILABLE } from "../../src/util/external-commands"

// XCOD-254: which typed commands Lunos expands in a Claude Code / Codex session.

describe("Lunos commands in an external session", () => {
  const own = ["compact", "review"]
  const lunos = ["greet", "review"]

  test("a Lunos command runs in Lunos; the tool's own command goes to the tool", () => {
    expect(lunosCommand("/greet Petar", own, lunos)).toEqual({ name: "greet", args: "Petar" })
    expect(lunosCommand("/review main", own, lunos)).toBeUndefined()
    expect(lunosCommand("/compact", own, lunos)).toBeUndefined()
    expect(lunosCommand("fix the test", own, lunos)).toBeUndefined()
  })

  test("on a clash the Lunos command is `name:lunos`, arguments and later lines kept", () => {
    expect(lunosName("review", own)).toBe("review:lunos")
    expect(lunosName("greet", own)).toBe("greet")
    expect(lunosCommand("/review:lunos main\nsecond line", own, lunos)).toEqual({
      name: "review",
      args: "main\nsecond line",
    })
    expect(lunosCommand("/nope:lunos x", own, lunos)).toBeUndefined()
  })

  test("commands for a Lunos agent, mode or model aren't available", () => {
    expect([...UNAVAILABLE].sort()).toEqual(["agents", "models", "modes", "providers", "variants"])
  })
})
