import type { Marketplace } from "@opencode-ai/core/marketplace"
import {
  resolveAddedMarketplaces,
  defaultMarketplaceListDeps,
  type MarketplaceCtx,
  type MarketplaceListDeps,
} from "./shared"
import { pluginInstallSpec, type PluginMarketplaceStatus } from "../plugin/discover"

// One row per installable thing across every added marketplace, tagged with its content kind.
// The CLI (`marketplace search`/`install`) and the TUI Discover tabs both read this, so a kind
// can't appear in one surface and be missing from the other.
type Row<K extends Marketplace.Kind, E> = {
  kind: K
  name: string
  marketplace: string
  description?: string
  category?: string
  tags?: readonly string[]
  entry: E
}

export type ContentItem =
  | (Row<"plugin", Marketplace.Entry> & { spec: string })
  | Row<"skill", Marketplace.SkillEntry>
  | Row<"hook", Marketplace.HookEntry>
  | Row<"mcp", Marketplace.McpEntry>

export type ContentListResult = {
  marketplaceCount: number
  marketplaces: PluginMarketplaceStatus[]
  items: ContentItem[]
}

function rows(manifest: Marketplace.Manifest): ContentItem[] {
  const marketplace = manifest.name
  const meta = (entry: { name: string; description?: string; category?: string; tags?: readonly string[] }) => ({
    name: entry.name,
    marketplace,
    description: entry.description,
    category: entry.category,
    tags: entry.tags,
  })
  return [
    ...manifest.plugins.map((entry) => ({
      kind: "plugin" as const,
      ...meta(entry),
      entry,
      spec: pluginInstallSpec(entry.source),
    })),
    // Every array but `plugins` is optional: manifests published before a kind existed have none.
    ...(manifest.skills ?? []).map((entry) => ({ kind: "skill" as const, ...meta(entry), entry })),
    ...(manifest.hooks ?? []).map((entry) => ({ kind: "hook" as const, ...meta(entry), entry })),
    ...(manifest.mcp ?? []).map((entry) => ({ kind: "mcp" as const, ...meta(entry), entry })),
  ]
}

export async function listContent(
  ctx: MarketplaceCtx,
  kind?: Marketplace.Kind,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<ContentListResult> {
  const resolved = await resolveAddedMarketplaces(ctx, dep)
  const marketplaces: PluginMarketplaceStatus[] = []
  const items: ContentItem[] = []
  for (const entry of resolved) {
    if (!entry.ok) continue
    marketplaces.push({
      name: entry.manifest.name,
      source: entry.source,
      fetchedAt: entry.fetchedAt,
      stale: entry.stale,
    })
    for (const item of rows(entry.manifest)) {
      if (!kind || item.kind === kind) items.push(item)
    }
  }
  return { marketplaceCount: resolved.length, marketplaces, items }
}

// Same haystack as searchPlugins/searchMcpServers, so a query matches identically on every tab.
export function matchesQuery(item: Pick<ContentItem, "name" | "description" | "category" | "tags">, query: string) {
  const needle = query.trim().toLowerCase()
  const haystack = [item.name, item.description ?? "", item.category ?? "", ...(item.tags ?? [])]
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

export async function searchContent(
  query: string,
  ctx: MarketplaceCtx,
  kind?: Marketplace.Kind,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<ContentListResult> {
  const result = await listContent(ctx, kind, dep)
  return { ...result, items: result.items.filter((item) => matchesQuery(item, query)) }
}
