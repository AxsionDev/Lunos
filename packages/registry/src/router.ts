import type { RegistryReadDb } from "./db"
import { handleMarketplaceJson } from "./handlers/marketplace-json"
import { handleMarketplaces } from "./handlers/marketplaces"
import { handlePlugins } from "./handlers/plugins"
import { handlePluginsSearch } from "./handlers/plugins-search"
import { internalError, methodNotAllowed, notFound } from "./response"

/**
 * Every handler receives the parsed URL (for query parameters) and the read seam — never
 * the raw `Env` or the D1 binding, so no handler can reach around `RegistryReadDb`.
 */
export type Handler = (ctx: { readonly url: URL; readonly db: RegistryReadDb }) => Promise<Response>

/**
 * Exact pathname -> handler. No router library, per this repo's Worker convention
 * (cf. the manual `pathname` branching in packages/console/function/src/auth.ts).
 *
 * Exact equality only — no trailing-slash normalisation, so `/plugins/` is a 404.
 * Deliberate: KISS, and no client produces it.
 *
 * `/plugins/search` is an ordinary entry and not a prefix match: it is a sibling key, so the
 * `/plugins` entry above never shadows it and the two cannot be reordered into a conflict.
 *
 * COMPLETE as of C-003 — all four contracted paths (§4.3) are now routed, and the router
 * needs no further changes for XCOD-34.
 */
const routes: Record<string, Handler> = {
  "/marketplace.json": handleMarketplaceJson, // C-001
  "/marketplaces": handleMarketplaces, // C-002
  "/plugins": handlePlugins, // C-002
  "/plugins/search": handlePluginsSearch, // C-003
}

/**
 * The whole request pipeline, taking the read seam as a parameter so every branch below is
 * testable against a fake `RegistryReadDb` with no D1, no `miniflare` and no deploy.
 * `index.ts` is the only place the real binding is bound to it.
 */
export async function handleRequest(request: Request, db: RegistryReadDb): Promise<Response> {
  const url = new URL(request.url)

  // Order is load-bearing (GAP-004): match the PATH first, then the method, so
  //   POST /marketplace.json -> 405 (known path, wrong method)
  //   POST /nope             -> 404 (genuinely unmatched path)
  const handler = routes[url.pathname]
  if (!handler) return notFound()
  if (request.method !== "GET") return methodNotAllowed()

  try {
    return await handler({ url, db })
  } catch (error) {
    // Logged, never returned: the client gets a fixed string, not the D1 error, which can
    // leak SQL and schema details. This single catch is what satisfies every endpoint's
    // "D1 query failure / binding unavailable -> 5xx with { error: string }" AC (C-001,
    // C-002, C-003) — handlers must NOT catch D1 errors themselves (gotcha #8).
    console.error("registry request failed", url.pathname, error)
    return internalError()
  }
}
