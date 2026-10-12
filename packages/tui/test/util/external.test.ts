import { describe, expect, test } from "bun:test"
import { externalCost, externalOf, parseExternalSlash, refusalMessage } from "../../src/util/external"

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
