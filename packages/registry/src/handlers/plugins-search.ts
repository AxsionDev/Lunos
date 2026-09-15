import { matchesQuery } from "../db"
import { badRequest } from "../response"
import type { Handler } from "../router"
import { toPluginEntry } from "./plugins"

/**
 * `GET /plugins/search?q=<query>` — `GET /plugins`, scoped to the rows matching `q`.
 *
 * BUNDLE CONSTRAINT (gotcha #3): type-only imports of `@opencode-ai/core/marketplace` and no
 * import of `effect` at all. `matchesQuery` and `toPluginEntry` are plain value imports from
 * this package's own modules, both of which are already on the Worker's graph.
 *
 * This handler is deliberately almost empty. Every decision it could plausibly own already
 * lives somewhere shared:
 *   - the haystack (name / description / category / tags, NOT author, NOT marketplace) is
 *     `matchesQuery` in db.ts (contracts §2.5), mirroring the client's `searchPlugins`;
 *   - the filtering itself is `listPlugins`' own `filter` option, so pushing the predicate
 *     into SQL later stays behind the `RegistryReadDb` seam;
 *   - the response projection is `toPluginEntry`, imported from plugins.ts rather than
 *     re-derived, which is what makes §4.4's "identical to `GET /plugins`" structural.
 * What remains here is exactly one endpoint-specific decision: GAP-001's absent-`q` 400.
 */
export const handlePluginsSearch: Handler = async ({ url, db }) => {
  // GAP-001, first half: `q` ENTIRELY ABSENT is a client error — the one 4xx any handler in
  // this Worker raises itself (contracts §4.3). `has()` and not a truthiness check on
  // `get()`: `?q=` yields `""`, which is falsy but is a legal, meaningful query.
  if (!url.searchParams.has("q")) return badRequest("Missing required query parameter: q")

  // GAP-001, second half: `?q=` and `?q=%20%20` are PRESENT-but-empty and must return every
  // plugin. That is not special-cased here — `matchesQuery` trims to the needle `""`, and
  // `includes("")` is always true, which is the client's `searchPlugins` behavior byte for
  // byte. A guard here would be a second, drifting definition of the same rule.
  //
  // The `?? ""` is unreachable after the `has()` guard above; it exists only because
  // `URLSearchParams.get` is typed `string | null`, and it is preferable to a `!` assertion.
  const query = url.searchParams.get("q") ?? ""

  // No try/catch — a D1 failure propagates to the router's single handler (gotcha #8).
  const plugins = await db.listPlugins({ filter: matchesQuery(query) })

  // No matches yields `{ "plugins": [] }` — a 200 with an empty array, explicitly never a
  // 404 (XCOD-33's spec calls this out directly).
  return Response.json({ plugins: plugins.map(toPluginEntry) })
}
