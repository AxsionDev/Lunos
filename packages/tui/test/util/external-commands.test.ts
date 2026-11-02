import { describe, expect, test } from "bun:test"
import { externalModelOptions, lunosCommand, lunosName, MAPPED, UNAVAILABLE } from "../../src/util/external-commands"

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

  test("commands for a Lunos agent, mode or model provider aren't available", () => {
    expect([...UNAVAILABLE].sort()).toEqual(["agents", "modes", "providers", "variants"])
  })

  test("/models and /cost act on the tool's session", () => {
    expect([...MAPPED].sort()).toEqual(["cost", "models"])
  })
})

describe("/models in an external session (XCOD-254)", () => {
  test("Claude Code's own `default` entry is the tool's default: no --model", () => {
    const rows = externalModelOptions(
      [
        { id: "default", name: "Default (recommended)", description: "Opus 5.5", default: true },
        { id: "sonnet", name: "Sonnet" },
      ],
      "Claude Code",
    )
    expect(rows).toEqual([
      { value: "", title: "Default (recommended)", description: "Opus 5.5" },
      { value: "sonnet", title: "Sonnet", description: "" },
    ])
  })

  test("otherwise a Default row comes first, and the tool's default model is marked", () => {
    const rows = externalModelOptions(
      [
        { id: "gpt-5.5", name: "GPT-5.5", description: "Latest", default: true },
        { id: "gpt-5.5-mini", name: "GPT-5.5 mini" },
      ],
      "Codex",
    )
    expect(rows.map((row) => [row.value, row.title, row.description])).toEqual([
      ["", "Default", "Codex's own default"],
      ["gpt-5.5", "GPT-5.5", "Latest · default"],
      ["gpt-5.5-mini", "GPT-5.5 mini", ""],
    ])
  })
})
