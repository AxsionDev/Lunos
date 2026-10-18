// XCOD-258: what each kind's marketplace tab shows beside the name, from the manifest entry.
import { describe, expect, test } from "bun:test"
import { Residency } from "@opencode-ai/core/residency"
import { marketplaceDetails } from "@/plugin/tui/runtime"
import type { ContentItem } from "@/marketplace/content"

const base = { marketplace: "fixture", source: "/tmp/fixture" }

describe("marketplace details (XCOD-258)", () => {
  test("a hook shows its event, matcher and the command it runs", () => {
    const item = {
      ...base,
      kind: "hook",
      name: "block-rm",
      entry: { name: "block-rm", event: "PreToolUse", command: ["node", "block.js"], matcher: { tool: "Bash" } },
    } as unknown as ContentItem
    expect(marketplaceDetails(item, undefined)).toEqual({
      event: "PreToolUse",
      matcher: "Bash",
      command: "node block.js",
    })
  })

  test("an MCP server shows how it's reached; a remote one its host, region and the policy's answer", () => {
    const local = { ...base, kind: "mcp", name: "git", entry: { type: "local", command: ["npx", "git-mcp"] } }
    expect(marketplaceDetails(local as unknown as ContentItem, undefined)).toEqual({
      transport: "stdio",
      command: "npx git-mcp",
    })
    const remote = {
      ...base,
      kind: "mcp",
      name: "docs",
      entry: { type: "remote", url: "https://mcp.example.eu/docs" },
    } as unknown as ContentItem
    // No residency policy: no answer to show, and an undeclared host's region is unknown.
    expect(marketplaceDetails(remote, undefined)).toEqual({
      transport: "http",
      host: "mcp.example.eu",
      region: "region unknown",
    })
    const euOnly = Residency.resolve({ allow: ["eu"] } as Parameters<typeof Residency.resolve>[0])
    expect(marketplaceDetails(remote, euOnly)).toMatchObject({ policy: "blocked" })
    const declared = Residency.resolve({
      allow: ["eu"],
      endpoints: { docs: { region: "eu" } },
    } as Parameters<typeof Residency.resolve>[0])
    expect(marketplaceDetails(remote, declared)).toMatchObject({ region: "eu", policy: "allowed" })
  })

  test("a plugin shows its version", () => {
    const item = { ...base, kind: "plugin", name: "p", spec: "p", entry: { name: "p", version: "1.2.0" } }
    expect(marketplaceDetails(item as unknown as ContentItem, undefined)).toEqual({ version: "1.2.0" })
  })
})
