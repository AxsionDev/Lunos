import { describe, expect, test } from "bun:test"
import * as RightPane from "../../src/util/right-pane"

// XCOD-307: hiding the right pane, the setting's three choices, and the « chip's badge.

const at = (pref: RightPane.Pane, wide: boolean, open = false) => ({ pref, wide, open })

describe("placement", () => {
  test("Auto docks on a wide terminal; narrow, it's an overlay only once opened", () => {
    expect(RightPane.placement(at("auto", true))).toBe("docked")
    expect(RightPane.placement(at("auto", false))).toBe("hidden")
    expect(RightPane.placement(at("auto", false, true))).toBe("overlay")
  })

  test("Always show docks at any width; Hidden stays hidden until opened", () => {
    expect(RightPane.placement(at("show", false))).toBe("docked")
    expect(RightPane.placement(at("show", true))).toBe("docked")
    expect(RightPane.placement(at("hide", true))).toBe("hidden")
    expect(RightPane.placement(at("hide", false))).toBe("hidden")
  })

  test("only a docked pane takes the conversation's columns", () => {
    expect(RightPane.taken(at("auto", true))).toBe(RightPane.PANE_WIDTH)
    expect(RightPane.taken(at("auto", false, true))).toBe(0)
    expect(RightPane.taken(at("hide", true))).toBe(0)
    expect(RightPane.taken(at("show", false))).toBe(RightPane.PANE_WIDTH)
  })
})

describe("toggle", () => {
  test("hiding a docked pane is remembered as Hidden; bringing it back returns to Auto", () => {
    const hidden = RightPane.toggled(at("auto", true))
    expect(hidden).toEqual({ pref: "hide", open: false })
    expect(RightPane.placement({ ...hidden, wide: true })).toBe("hidden")
    const back = RightPane.toggled({ ...hidden, wide: true })
    expect(back).toEqual({ pref: "auto", open: true })
    expect(RightPane.placement({ ...back, wide: true })).toBe("docked")
  })

  test("Always show hides as Hidden too", () => {
    expect(RightPane.toggled(at("show", true))).toEqual({ pref: "hide", open: false })
  })

  test("narrow and Auto: opening and closing the overlay never writes Hidden", () => {
    const open = RightPane.toggled(at("auto", false))
    expect(open).toEqual({ pref: "auto", open: true })
    expect(RightPane.placement({ ...open, wide: false })).toBe("overlay")
    const closed = RightPane.toggled({ ...open, wide: false })
    expect(closed).toEqual({ pref: "auto", open: false })
    // Wide again, the pane is back where Auto puts it.
    expect(RightPane.placement({ ...closed, wide: true })).toBe("docked")
  })

  test("narrow and Hidden: the keybind opens it as an overlay, in Auto", () => {
    const open = RightPane.toggled(at("hide", false))
    expect(open).toEqual({ pref: "auto", open: true })
    expect(RightPane.placement({ ...open, wide: false })).toBe("overlay")
  })
})

test("a stored value that isn't a choice reads as Auto (the old `sidebar` key held auto or hide)", () => {
  expect(RightPane.pane(undefined)).toBe("auto")
  expect(RightPane.pane("hide")).toBe("hide")
  expect(RightPane.pane("show")).toBe("show")
  expect(RightPane.pane("nonsense")).toBe("auto")
  expect(RightPane.PANE_KEY.session).toBe("sidebar")
})

describe("attention", () => {
  const none = { waiting: 0, budgets: [], lsp: [], mcp: [] }

  test("nothing needs you: no count, no label", () => {
    expect(RightPane.attention(none)).toEqual({ count: 0, label: "" })
    // Informational states don't count.
    expect(
      RightPane.attention({
        ...none,
        budgets: [{ percent: 79 }],
        lsp: [{ status: "connected" }, { status: "starting" }],
        mcp: [{ status: "connected" }, { status: "disabled" }],
      }).count,
    ).toBe(0)
  })

  test("waiting subagents, budgets past the warning, failed LSP and MCP servers each count", () => {
    const result = RightPane.attention({
      waiting: 2,
      budgets: [{ percent: 80 }, { percent: 120 }, { percent: 10 }],
      lsp: [{ status: "error" }, { status: "connected" }],
      mcp: [{ status: "failed" }, { status: "needs_auth" }, { status: "connected" }],
    })
    expect(result.count).toBe(7)
    expect(result.label).toBe(
      "7 need you: 2 waiting for action, 2 budget warning, 1 LSP server failed, 2 MCP server failed",
    )
    expect(RightPane.attention({ ...none, waiting: 1 }).label).toBe("1 needs you: 1 waiting for action")
  })
})

describe("waitingSubagents", () => {
  const sessions = [
    { id: "root" },
    { id: "a", parentID: "root" },
    { id: "b", parentID: "root" },
    { id: "a1", parentID: "a" },
    { id: "a1x", parentID: "a1" },
    { id: "other" },
    { id: "o1", parentID: "other" },
  ]

  test("counts subagents at any depth with an ask pending, not the session itself or another's", () => {
    const pending = new Set(["root", "b", "a1x", "o1"])
    expect(RightPane.waitingSubagents("root", sessions, (id) => pending.has(id))).toBe(2)
  })

  test("none pending, none counted; a cycle doesn't loop", () => {
    expect(RightPane.waitingSubagents("root", sessions, () => false)).toBe(0)
    const cycle = [
      { id: "x", parentID: "y" },
      { id: "y", parentID: "x" },
    ]
    expect(RightPane.waitingSubagents("x", cycle, () => true)).toBe(1)
  })
})
