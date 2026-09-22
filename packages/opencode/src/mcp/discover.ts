import type { Marketplace } from "@opencode-ai/core/marketplace"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
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

// The manifest carries variable NAMES; config wants name -> value. We write `{env:NAME}`, the
// substitution syntax config already supports (see docs/config.mdx). The generated
// opencode.json therefore contains no secret and is safe to commit to a repository — which it
// would not be had we prompted for key values and written them literally.
//
// `environment`/`headers` are a bare `Schema.Array(String)` with no identifier constraint, so
// nothing stops a third-party marketplace (unlike our own published manifest, which the web repo
// guards) from declaring a "name" like "API_TOKEN=secret". Left unchecked that would flow
// straight through as `{env:API_TOKEN=secret}` -- a literal value written into the user's config,
// exactly what this scheme exists to avoid. We throw rather than silently drop it: every other
// refusal on the marketplace add path (ambiguous name, existing entry) is a thrown Error the
// caller turns into a failed `mcp add` with a message, and a malformed declared name deserves the
// same rather than a server that's silently missing a variable it needs.
function envReferences(entryName: string, names: readonly string[] | undefined) {
  if (!names?.length) return undefined
  for (const name of names) {
    if (name.includes("=")) {
      throw new Error(`MCP server "${entryName}" declares an invalid environment/header name: "${name}"`)
    }
  }
  return Object.fromEntries(names.map((name) => [name, `{env:${name}}`]))
}

export function mcpConfigFromEntry(entry: Marketplace.McpEntry): ConfigMCPV1.Info {
  if (entry.type === "remote") {
    const headers = envReferences(entry.name, entry.headers)
    return {
      type: "remote",
      url: entry.url,
      enabled: true,
      ...(headers ? { headers } : {}),
    }
  }
  const environment = envReferences(entry.name, entry.environment)
  return {
    type: "local",
    command: [...entry.command],
    enabled: true,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(environment ? { environment } : {}),
  }
}
