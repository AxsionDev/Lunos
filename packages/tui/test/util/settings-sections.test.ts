import { describe, expect, test } from "bun:test"
import * as Sections from "../../src/util/settings-sections"

// XCOD-259: /settings sections: deep links, breadcrumbs and badges.

describe("settings sections", () => {
  test("deep links name a section and optionally a sub-tab", () => {
    expect(Sections.target("memory")).toEqual({ category: "Memory" })
    expect(Sections.target("tools lsp")).toEqual({ category: "Tools", sub: "LSP" })
    expect(Sections.target("models external")).toEqual({ category: "Models & agents", sub: "External sessions" })
    // An alias that is itself a sub-tab lands on it.
    expect(Sections.target("lsp")).toEqual({ category: "Tools", sub: "LSP" })
    expect(Sections.target("Residency")).toEqual({ category: "Residency & privacy", sub: "Residency" })
    expect(Sections.target("nonsense")).toBeUndefined()
  })

  test("a search result says where it lives", () => {
    expect(Sections.breadcrumb({ category: "Memory", sub: "Advanced", key: "memory.audit.enabled" })).toBe(
      "Memory › Advanced › memory.audit.enabled",
    )
    expect(Sections.breadcrumb({ category: "Updates", key: "autoupdate" })).toBe("Updates › autoupdate")
  })

  test("badges count changed and locked rows, and a saved change waiting for a restart", () => {
    const rows = [
      { key: "memory.enabled", source: "user" as const, locked: false },
      { key: "memory.model", source: "managed" as const, locked: true },
      { key: "memory.retention.days", source: "default" as const, locked: false },
    ]
    expect(Sections.badges(rows, new Set())).toBe("1 changed · 🔒 1")
    expect(Sections.badges(rows, new Set(["memory.enabled"]))).toBe("1 changed · 🔒 1 · ↻ restart")
    expect(Sections.badges([], new Set())).toBe("")
  })

  test("summaries say what's set", () => {
    expect(Sections.summary("Appearance", [{ key: "tui.theme", display: "catppuccin", source: "default" }])).toBe(
      "catppuccin",
    )
    expect(
      Sections.summary("Memory", [
        { key: "memory.enabled", display: "true", source: "user" },
        { key: "memory.backend.type", display: "neo4j", source: "user" },
      ]),
    ).toBe("on · Neo4j")
    // XCOD-264: the config value "embedded" is never shown.
    expect(
      Sections.summary("Memory", [
        { key: "memory.enabled", display: "true", source: "user" },
        { key: "memory.backend.type", display: "embedded", source: "user" },
      ]),
    ).toBe("on · on this computer")
  })
})
