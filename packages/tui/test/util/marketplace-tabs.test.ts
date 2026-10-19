import { describe, expect, test } from "bun:test"
import type { TuiMarketplaceEntry } from "@opencode-ai/plugin/tui"
import * as Tabs from "../../src/util/marketplace-tabs"

// XCOD-258: the marketplace tab bar: tabs from the catalogue's kinds, counts that follow the search,
// and each kind's own columns.

const entry = (kind: string, name: string, extra: Partial<TuiMarketplaceEntry> = {}) =>
  ({ kind, name, marketplace: "fixture", ...extra }) as TuiMarketplaceEntry

const items = [
  entry("plugin", "notify-plus", {
    description: "Desktop notifications",
    details: { version: "1.2.0" },
    installed: "installed",
  }),
  entry("skill", "eu-docs", { description: "Docs for EU readers" }),
  entry("hook", "block-rm", {
    details: { event: "PreToolUse", matcher: "Bash", command: "node ./hooks/block-rm.js --strict" },
  }),
  entry("mcp", "git", { details: { transport: "stdio", command: "npx -y git-mcp" }, installed: "update" }),
  entry("mcp", "mistral-docs", {
    details: { transport: "http", host: "mcp.mistral.ai", region: "eu", policy: "blocked" },
  }),
]

describe("marketplace tabs", () => {
  test("All, the four kinds (even empty) and Installed; an unknown kind gets its own tab", () => {
    expect(Tabs.tabs([])).toEqual(["all", "plugin", "skill", "hook", "mcp", "installed"])
    expect(Tabs.tabs([...items, entry("agent", "reviewer")])).toEqual([
      "all",
      "plugin",
      "skill",
      "hook",
      "mcp",
      "agent",
      "installed",
    ])
    expect(Tabs.title("agent")).toBe("Agents")
    expect(Tabs.title("mcp")).toBe("MCP")
  })

  test("counts follow the search on every tab", () => {
    expect(Tabs.counts(items, "")).toMatchObject({ all: 5, plugin: 1, skill: 1, hook: 1, mcp: 2, installed: 2 })
    expect(Tabs.counts(items, "git")).toMatchObject({ all: 1, plugin: 0, mcp: 1, installed: 1 })
    // What a hook runs and an MCP server's host are searchable too.
    expect(Tabs.counts(items, "block-rm.js")).toMatchObject({ hook: 1 })
    expect(Tabs.counts(items, "mistral.ai")).toMatchObject({ mcp: 1 })
  })

  test("Installed lists updates first, then by kind", () => {
    expect(Tabs.rows(items, "installed", "").map((item) => item.name)).toEqual(["git", "notify-plus"])
  })

  test("each kind shows its own columns; a hook always shows what it runs", () => {
    const by = (name: string) => items.find((item) => item.name === name)!
    expect(Tabs.describe(by("notify-plus"), false)).toBe("v1.2.0 · Desktop notifications")
    expect(Tabs.describe(by("block-rm"), false)).toBe("PreToolUse · Bash · runs node ./hooks/block-rm.js --strict")
    expect(Tabs.describe(by("mistral-docs"), false)).toBe("http · mcp.mistral.ai · eu · blocked by policy")
    expect(Tabs.describe(by("eu-docs"), true)).toBe("Skill · Docs for EU readers")
  })

  test("empty tabs say how to get some", () => {
    expect(Tabs.empty("hook")).toBe("No hooks in your marketplaces. Add one: lunos marketplace add <owner/repo>")
    expect(Tabs.empty("installed")).toBe("Nothing from your marketplaces is installed.")
  })
})
