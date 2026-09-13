import type { Marketplace } from "@opencode-ai/core/marketplace"
import {
  resolveAddedMarketplaces,
  defaultMarketplaceListDeps,
  type MarketplaceCtx,
  type MarketplaceListDeps,
} from "../marketplace/shared"

// The concrete spec accepted by the existing `opencode plugin <module>` install command (via
// npm-package-arg / `Npm.add`), so plugin discovery output (CLI `plugin list`/`search`, TUI
// Discover view) is a direct copy-paste/select away from installing.
export function pluginInstallSpec(source: Marketplace.Source): string {
  if (source.type === "npm") return source.version ? `${source.package}@${source.version}` : source.package
  return source.ref ? `${source.repo}#${source.ref}` : source.repo
}

export type PluginListEntry = {
  name: string
  marketplace: string
  description?: string
  category?: string
  tags?: readonly string[]
  spec: string
}

export type PluginListResult = {
  marketplaceCount: number
  plugins: PluginListEntry[]
}

export async function listPlugins(
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<PluginListResult> {
  const resolved = await resolveAddedMarketplaces(ctx, dep)
  const plugins: PluginListEntry[] = []
  for (const entry of resolved) {
    if (!entry.ok) continue
    for (const plugin of entry.manifest.plugins) {
      plugins.push({
        name: plugin.name,
        marketplace: entry.manifest.name,
        description: plugin.description,
        category: plugin.category,
        tags: plugin.tags,
        spec: pluginInstallSpec(plugin.source),
      })
    }
  }
  return { marketplaceCount: resolved.length, plugins }
}

export async function searchPlugins(
  query: string,
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<PluginListResult> {
  const { marketplaceCount, plugins } = await listPlugins(ctx, dep)
  const needle = query.trim().toLowerCase()
  const matches = plugins.filter((item) => {
    const haystack = [item.name, item.description ?? "", item.category ?? "", ...(item.tags ?? [])]
    return haystack.some((value) => value.toLowerCase().includes(needle))
  })
  return { marketplaceCount, plugins: matches }
}
