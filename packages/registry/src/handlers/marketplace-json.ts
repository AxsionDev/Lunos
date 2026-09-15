import { REGISTRY_MANIFEST_NAME, REGISTRY_MANIFEST_OWNER } from "../db"
import type { EntryJson, ManifestJson, PluginRecord } from "../db"
import type { Handler } from "../router"

/**
 * `GET /marketplace.json` — the registry served back as a single, bare
 * `Marketplace.Manifest` document. The only endpoint a real client calls: the Lunos CLI's
 * `marketplace add` (EUSR-001) fetches this URL and runs it straight through
 * `Marketplace.decode` in `resolveMarketplaceManifest`
 * (packages/opencode/src/marketplace/shared.ts).
 *
 * BUNDLE CONSTRAINT (gotcha #3): every `@opencode-ai/core/marketplace` type reaches this
 * file INDIRECTLY, re-exported as a derived alias from `../db`, and `../db` imports it with
 * a top-level `import type`. No value import of that module — or of `effect` — exists
 * anywhere on the Worker's import graph. Decoding happens only in the seed script and in
 * tests, both of which run under Bun.
 */

/**
 * `PluginRecord` -> `Entry`: strip the registry-native `marketplace` field that
 * `listPlugins` denormalizes onto every row, and emit nothing else.
 *
 * Written as an EXPLICIT field list rather than a `{ marketplace: _, ...entry }` rest
 * spread so the emitted shape is pinned to contracts §4.4's column, not to whatever
 * `PluginRecord` happens to carry — a future registry-native column added to the `plugin`
 * table would otherwise leak silently into a document whose whole contract is "a bare,
 * decode-valid Manifest with zero extra fields".
 *
 * The `undefined`-valued keys below are dropped by `JSON.stringify`, so an absent optional
 * is an absent KEY on the wire. That only holds because `toPluginRecord` already mapped
 * every SQL NULL through `optional()` — `JSON.stringify` preserves `null` (gotcha #2).
 */
function toEntry(plugin: PluginRecord): EntryJson {
  return {
    name: plugin.name,
    source: plugin.source,
    description: plugin.description,
    version: plugin.version,
    author: plugin.author,
    category: plugin.category,
    tags: plugin.tags,
  }
}

export const handleMarketplaceJson: Handler = async ({ db }) => {
  // No filter: the registry's own manifest aggregates EVERY plugin across EVERY ingested
  // marketplace. No try/catch — a D1 failure must propagate to the router's single
  // handler, which is what keeps the 500 envelope uniform (gotcha #8).
  const plugins = await db.listPlugins()

  /**
   * Top-level identity is FIXED (GAP-002) — literal constants, never derived from, or
   * compared against, any seeded marketplace row's own `name`/`owner`. The seeded manifest
   * is `lunos-community`; this aggregate document is `lunos-registry`, and the two must
   * never be conflated.
   *
   * `description`, `version` and `$schema` are OMITTED, not filled: all three are optional
   * in XCOD-8, so the document still decodes, and GAP-002 resolved only `name` and `owner`.
   * Inventing a placeholder for the rest would reproduce exactly the failure mode GAP-002
   * warned about (contracts §4.4). Nothing client-side reads either field.
   *
   * The `ManifestJson` annotation is load-bearing: its excess-property check is what
   * enforces "zero extra top-level fields" at compile time — any wrapper key would break
   * the client's `Marketplace.decode`.
   */
  const manifest: ManifestJson = {
    name: REGISTRY_MANIFEST_NAME,
    owner: REGISTRY_MANIFEST_OWNER,
    // Empty D1 yields `[]` — a valid, schema-conformant empty array, never a 404.
    plugins: plugins.map(toEntry),
  }

  return Response.json(manifest)
}
