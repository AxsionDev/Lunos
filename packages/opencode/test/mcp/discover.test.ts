import { describe, expect, test } from "bun:test"
import { listMcpServers, searchMcpServers } from "../../src/mcp/discover"

// A fake that satisfies MarketplaceListDeps' resolveAddedMarketplaces seam, so these tests
// exercise merge and filter behaviour without the network or the 24h disk cache.
function depsReturning(manifests: Array<{ name: string; mcp?: unknown[] }>) {
  return {
    resolveAddedMarketplaces: async () =>
      manifests.map((manifest) => ({
        ok: true as const,
        source: `https://example.test/${manifest.name}.json`,
        fetchedAt: 0,
        manifest: { name: manifest.name, owner: { name: "o" }, plugins: [], mcp: manifest.mcp ?? [] },
      })),
  } as any
}

const filesystem = {
  name: "filesystem",
  type: "local",
  command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
  description: "Secure file operations",
  category: "environment",
}
const searxng = { name: "searxng", type: "local", command: ["npx", "-y", "mcp-searxng"], category: "search" }

describe("listMcpServers", () => {
  test("merges servers from every added marketplace", async () => {
    const result = await listMcpServers({} as any, depsReturning([
      { name: "a", mcp: [filesystem] },
      { name: "b", mcp: [searxng] },
    ]))

    expect(result.servers.map((s) => s.name)).toEqual(["filesystem", "searxng"])
    expect(result.servers[0]?.marketplace).toBe("a")
    expect(result.marketplaceCount).toBe(2)
  })

  test("treats a manifest with no mcp key as contributing no servers", async () => {
    // Every manifest published before the schema change is in this shape.
    const result = await listMcpServers({} as any, depsReturning([{ name: "a" }]))
    expect(result.servers).toEqual([])
  })
})

describe("searchMcpServers", () => {
  test("matches on category as well as name and description", async () => {
    const result = await searchMcpServers("search", {} as any, depsReturning([
      { name: "a", mcp: [filesystem, searxng] },
    ]))
    expect(result.servers.map((s) => s.name)).toEqual(["searxng"])
  })
})
