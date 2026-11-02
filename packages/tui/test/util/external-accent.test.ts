import { describe, expect, test } from "bun:test"
import { EXTERNAL_BADGE, externalAccent, externalBadge } from "../../src/util/external"

// XCOD-260: how an external session is marked: the products' plain names beside ours, and an accent
// that never carries the meaning alone.

describe("external session badge and accent", () => {
  test("the badge names Lunos and the tool side by side, with the model when known", () => {
    expect(externalBadge("claude")).toBe("Lunos · Claude Code")
    expect(externalBadge("codex", "gpt-6")).toBe("Lunos · Codex · gpt-6")
    expect(EXTERNAL_BADGE).toEqual({ claude: "Claude Code", codex: "Codex" })
  })

  test("the accent follows the tool, and is dropped when turned off or under NO_COLOR / TERM=dumb", () => {
    const theme = { externalClaude: "orange", externalCodex: "graphite" }
    expect(externalAccent(theme, "claude", true, {})).toBe("orange")
    expect(externalAccent(theme, "codex", true, {})).toBe("graphite")
    expect(externalAccent(theme, "claude", false, {})).toBeUndefined()
    expect(externalAccent(theme, "claude", true, { NO_COLOR: "1" })).toBeUndefined()
    expect(externalAccent(theme, "claude", true, { TERM: "dumb" })).toBeUndefined()
  })
})
