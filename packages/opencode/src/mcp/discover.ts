import type { Marketplace } from "@opencode-ai/core/marketplace"
import {
  resolveAddedMarketplaces,
  defaultMarketplaceListDeps,
  type MarketplaceCtx,
  type MarketplaceListDeps,
} from "../marketplace/shared"
import type { PluginMarketplaceStatus } from "../plugin/discover"

export type McpListEntry = {
  name: string
  marketplace: string
  description?: string
  category?: string
  tags?: readonly string[]
  entry: Marketplace.McpEntry
}

export type McpListResult = {
  marketplaceCount: number
  marketplaces: PluginMarketplaceStatus[]
  servers: McpListEntry[]
}

// Deliberately shaped like listPlugins in ../plugin/discover.ts: same traversal, same
// per-marketplace staleness summary, same search haystack. A reader who knows one knows both.
export async function listMcpServers(
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<McpListResult> {
  const resolved = await resolveAddedMarketplaces(ctx, dep)
  const marketplaces: PluginMarketplaceStatus[] = []
  const servers: McpListEntry[] = []
  for (const entry of resolved) {
    if (!entry.ok) continue
    marketplaces.push({
      name: entry.manifest.name,
      source: entry.source,
      fetchedAt: entry.fetchedAt,
      stale: entry.stale,
    })
    // `mcp` is optional: manifests published before the schema change simply have none.
    for (const server of entry.manifest.mcp ?? []) {
      servers.push({
        name: server.name,
        marketplace: entry.manifest.name,
        description: server.description,
        category: server.category,
        tags: server.tags,
        entry: server,
      })
    }
  }
  return { marketplaceCount: resolved.length, marketplaces, servers }
}

export async function searchMcpServers(
  query: string,
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<McpListResult> {
  const { marketplaceCount, marketplaces, servers } = await listMcpServers(ctx, dep)
  const needle = query.trim().toLowerCase()
  const matches = servers.filter((item) => {
    const haystack = [item.name, item.description ?? "", item.category ?? "", ...(item.tags ?? [])]
    return haystack.some((value) => value.toLowerCase().includes(needle))
  })
  return { marketplaceCount, marketplaces, servers: matches }
}
