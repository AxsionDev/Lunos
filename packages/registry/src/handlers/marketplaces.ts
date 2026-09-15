import type { MarketplaceRecord } from "../db"
import type { Handler } from "../router"

/**
 * `GET /marketplaces` — one entry per ingested marketplace, each carrying the manifest's
 * top-level fields plus the two registry-native ones (`pluginCount`, `source`).
 *
 * BUNDLE CONSTRAINT (gotcha #3): type-only imports exclusively. Every
 * `@opencode-ai/core/marketplace` type reaches this file indirectly, as a derived alias
 * re-exported from `../db`, which itself uses a top-level `import type`. No value import of
 * that module — or of `effect` — exists anywhere on the Worker's import graph.
 */

/**
 * Contracts §4.4's emitted field list, written EXPLICITLY rather than as an identity
 * pass-through of `MarketplaceRecord`. The two shapes are identical today, which is exactly
 * why the explicit list matters: a registry-native column added to the `marketplace` table
 * (XCOD-35's `ingested_at`, say) would otherwise appear on the wire the moment it appeared
 * on the record, with no test and no decision. Same discipline as `toEntry` in
 * marketplace-json.ts.
 *
 * `pluginCount` is a derived aggregate (a correlated COUNT in `LIST_MARKETPLACES_SQL`),
 * never a stored column — it is already computed by `toMarketplaceRecord`, so there is
 * nothing to recount here.
 *
 * `description` and `version` are `Schema.optional` in XCOD-8: `undefined` means "absent",
 * and `JSON.stringify` drops an `undefined`-valued key entirely. That only yields an absent
 * KEY (rather than a literal `null`) because `toMarketplaceRecord` already routed every
 * nullable column — including the nested `owner.email` / `owner.url` — through `optional()`
 * (gotcha #2).
 *
 * `version` IS emitted when present: contracts §4.4 resolves the disagreement between
 * XCOD-33's prose (which names it) and its example response (which depicts a manifest that
 * simply has none) in favour of the prose.
 */
function toMarketplaceEntry(record: MarketplaceRecord) {
  return {
    name: record.name,
    owner: record.owner,
    description: record.description,
    version: record.version,
    pluginCount: record.pluginCount,
    source: record.source,
  }
}

export const handleMarketplaces: Handler = async ({ db }) => {
  // No try/catch — a D1 failure must propagate to the router's single handler, which is what
  // keeps the 500 envelope uniform across every endpoint (gotcha #8).
  const marketplaces = await db.listMarketplaces()

  // Empty D1 yields `{ "marketplaces": [] }` — a 200 with an empty array, never a 404.
  return Response.json({ marketplaces: marketplaces.map(toMarketplaceEntry) })
}
