import { describe, expect, test } from "bun:test"
import {
  bridgeLine,
  externalCost,
  externalOf,
  parseExternalSlash,
  parseToolSlash,
  refusalMessage,
  toolUnavailable,
} from "../../src/util/external"

describe("external sessions in the TUI (XCOD-218)", () => {
  test("/external opens a picker; with a tool it starts one; resume takes an id", () => {
    expect(parseExternalSlash("/external")).toEqual({ pick: true })
    expect(parseExternalSlash("/external claude")).toEqual({ tool: "claude" })
    expect(parseExternalSlash("/external codex")).toEqual({ tool: "codex" })
    expect(parseExternalSlash("/external resume claude a6fd116c-92e4")).toEqual({
      tool: "claude",
      session: "a6fd116c-92e4",
    })
    expect(parseExternalSlash("/external claude a6fd116c")).toEqual({ tool: "claude", session: "a6fd116c" })
  })

  test("anything else is a usage hint, not a prompt; other text isn't ours", () => {
    expect(parseExternalSlash("/external gemini")).toHaveProperty("error")
    expect(parseExternalSlash("/external resume claude bad;id")).toHaveProperty("error")
    expect(parseExternalSlash("/externally")).toBeUndefined()
    expect(parseExternalSlash("hello")).toBeUndefined()
  })

  test("the marker is read from the session's metadata", () => {
    expect(externalOf({ metadata: { external: { tool: "claude", session: "x" } } })).toEqual({
      tool: "claude",
      session: "x",
    })
    expect(externalOf({ metadata: { external: { tool: "other" } } })).toBeUndefined()
    expect(externalOf(undefined)).toBeUndefined()
  })

  test("cost to four places; a refusal's reason is shown as sent", () => {
    expect(externalCost(0.3210852)).toBe("$0.3211")
    expect(refusalMessage({ message: "Claude Code sends your code to Anthropic" }, "x")).toContain("Anthropic")
    expect(refusalMessage({ data: { message: "nested" } }, "x")).toBe("nested")
    expect(refusalMessage(undefined, "fallback")).toBe("fallback")
  })
})

describe("/claude and /codex (XCOD-250)", () => {
  test("a task goes to the tool as typed, its own /commands included; no task means the picker", () => {
    expect(parseToolSlash("/claude Fix the failing test")).toEqual({ tool: "claude", text: "Fix the failing test" })
    expect(parseToolSlash("/codex /review")).toEqual({ tool: "codex", text: "/review" })
    expect(parseToolSlash("/claude")).toEqual({ tool: "claude", text: "" })
    expect(parseToolSlash("/claudette")).toBeUndefined()
    expect(parseToolSlash("ask /claude")).toBeUndefined()
  })

  test("greyed out with the reason: policy, not installed, not signed in; ready otherwise", () => {
    expect(toolUnavailable("claude", undefined)).toBeUndefined()
    expect(toolUnavailable("claude", { installed: true, loggedIn: true })).toBeUndefined()
    expect(toolUnavailable("claude", { installed: false })).toBe(
      "Claude Code isn't installed — see lunos external list",
    )
    expect(toolUnavailable("codex", { installed: true, loggedIn: false })).toBe(
      "Codex CLI isn't signed in — choose it to sign in",
    )
    expect(
      toolUnavailable("claude", { installed: true, refused: { reason: "residency", message: "sends your code to…" } }),
    ).toBe("blocked by policy")
    expect(
      toolUnavailable("claude", { installed: true, refused: { reason: "policy", message: "turned off by policy" } }),
    ).toBe("turned off by policy")
  })
})

describe("the Lunos bridge's status line (XCOD-254)", () => {
  test("counts, memory on/off, and a warning when the tool didn't connect", () => {
    expect(bridgeLine({ servers: 2, skills: 3, memory: true, connected: true })).toEqual({
      text: "Lunos bridge: 2 servers, 3 skills, memory on",
      warning: false,
    })
    expect(bridgeLine({ servers: 1, skills: 1, memory: false })).toEqual({
      text: "Lunos bridge: 1 server, 1 skill, memory off",
      warning: false,
    })
    expect(bridgeLine({ servers: 1, skills: 0, memory: false, connected: false })).toEqual({
      text: "Lunos bridge: 1 server, 0 skills, memory off ⚠ not connected",
      warning: true,
    })
    expect(bridgeLine({ servers: 0, skills: 0, memory: false, off: "not shared in this session" })).toEqual({
      text: "Lunos bridge: off (not shared in this session)",
      warning: false,
    })
    expect(bridgeLine(undefined)).toBeUndefined()
  })
})
