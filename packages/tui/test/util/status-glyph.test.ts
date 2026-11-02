import { describe, expect, test } from "bun:test"
import { STATUS_GLYPH, selectionMarker, statusGlyph, statusKind } from "../../src/util/status-glyph"

// XCOD-141: status must not rely on colour alone, so each state needs its own glyph.
describe("status glyphs", () => {
  test("every kind has a distinct glyph", () => {
    const glyphs = Object.values(STATUS_GLYPH)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  test("MCP, LSP and workspace statuses map to distinct shapes", () => {
    expect(statusGlyph("connected")).toBe("•")
    expect(statusGlyph("failed")).toBe("✕")
    expect(statusGlyph("error")).toBe("✕")
    expect(statusGlyph("needs_client_registration")).toBe("✕")
    expect(statusGlyph("needs_auth")).toBe("!")
    expect(statusGlyph("disabled")).toBe("○")
    expect(statusGlyph("disconnected")).toBe("○")
    expect(statusKind("connecting")).toBe("pending")
    expect(statusGlyph(undefined)).toBe("○")
  })

  test("selection marker keeps the same width selected or not", () => {
    expect(selectionMarker(true)).not.toBe(selectionMarker(false))
    expect(selectionMarker(true).length).toBe(selectionMarker(false).length)
  })
})
