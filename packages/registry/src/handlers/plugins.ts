import type { PluginRecord } from "../db"
import type { Handler } from "../router"

/**
 * `GET /plugins` — the full flattened plugin list across every ingested marketplace.
 *
 * BUNDLE CONSTRAINT (gotcha #3): type-only imports exclusively, as in every other file on
 * the Worker's import graph. No value import of `@opencode-ai/core/marketplace` or `effect`.
 */

/**
 * `PluginRecord` -> the six-field `/plugins` row of contracts §4.4.
 *
 * THE TRAP (gotcha #5): `PluginRecord` carries `author` and `version`, and this response
 * MUST NOT. A `{ marketplace, ...rest }`-style rest spread would leak both silently, which
 * is why this is an explicit field list — the same discipline, for a sharper reason, as
 * `toEntry` in marketplace-json.ts.
 *
 * The omission is deliberate and load-bearing, not an example oversight: the client's own
 * `PluginListEntry` (packages/opencode/src/plugin/discover.ts) carries exactly `name`,
 * `marketplace`, `description`, `category`, `tags` and `spec` — no `author`, no `version`.
 * This response is that same row with the raw `source` union in place of the collapsed
 * `spec` string. `PluginRecord` still carries both fields because `/marketplace.json`'s
 * `Entry` objects need them, and `GET /plugins/search` (C-003) reuses this same projection.
 *
 * `source` stays the RAW `Marketplace.Source` tagged union — already reassembled from the
 * discriminant + per-variant columns by `toSourceJson` — and is never collapsed into an
 * install-spec string the way `listPlugins`' client-side `PluginListEntry` does.
 *
 * `description`, `category` and `tags` are optional: `undefined` is dropped by
 * `JSON.stringify`, so an absent optional is an absent KEY rather than a literal `null`
 * (gotcha #2, upheld upstream by `toPluginRecord`'s `optional()` calls). `tags: []` is a
 * distinct, legal value that survives as an empty array.
 *
 * EXPORTED for `plugins-search.ts` (C-003) and for nothing else. §4.4 defines
 * `GET /plugins/search`'s shape as "identical to `GET /plugins`" — one exported function is
 * what makes that identity structural rather than a pair of field lists that agree today and
 * silently diverge on the next schema change. Do not copy this body into another handler.
 */
export function toPluginEntry(record: PluginRecord) {
  return {
    name: record.name,
    marketplace: record.marketplace,
    description: record.description,
    category: record.category,
    tags: record.tags,
    source: record.source,
  }
}

export const handlePlugins: Handler = async ({ db }) => {
  // No filter: every plugin across every marketplace. Filtering is C-003's concern, applied
  // through `listPlugins`' own `filter` option so the predicate stays behind the seam.
  // No try/catch — a D1 failure propagates to the router's single handler (gotcha #8).
  const plugins = await db.listPlugins()

  // Empty D1 yields `{ "plugins": [] }` — a 200 with an empty array, never a 404.
  return Response.json({ plugins: plugins.map(toPluginEntry) })
}
