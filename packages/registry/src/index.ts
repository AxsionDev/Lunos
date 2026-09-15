import type { D1Database } from "@cloudflare/workers-types"
import { d1ReadDb } from "./db"
import { handleRequest } from "./router"

/**
 * Declared locally in the handler file, per this repo's Worker convention
 * (cf. `type Env = { AuthStorage: KVNamespace }` in packages/console/function/src/auth.ts).
 * NOT sourced from sst-env.d.ts — that file only covers SST `Resource`-proxy values, not
 * raw Cloudflare bindings.
 *
 * The key MUST stay byte-identical to the SST logical name in infra/registry.ts:
 *   new sst.cloudflare.D1("MarketplaceRegistryDb", ...)
 *     -> link: [registryDb]
 *     -> env.MarketplaceRegistryDb
 *
 * STATUS: by analogy, NOT confirmed. auth.ts proves SST surfaces a linked
 * `sst.cloudflare.Kv("AuthStorage")` as `env.AuthStorage`; this repo has no D1 precedent,
 * so the D1 equivalent is inference. F-001's deploy AC ("the D1 binding resolves at runtime
 * without error") is the check that promotes it to confirmed. Do not treat it as settled
 * before then — see contracts doc §3 and gotcha #7.
 */
type Env = {
  MarketplaceRegistryDb: D1Database
}

/**
 * BUNDLE CONSTRAINT — binding on C-001 / C-002 / C-003 (contracts doc §5, gotcha #3).
 *
 * When this file, or anything under src/handlers/, needs the XCOD-8 marketplace schema it
 * MUST be brought in as a TYPE-ONLY import:
 *
 *   import type { Marketplace } from "@opencode-ai/core/marketplace"
 *
 * A value import drags `effect` into the Worker bundle for no runtime benefit: decoding
 * happens exclusively in F-002's seed script and in unit tests, both of which run under Bun,
 * never in the Worker. `effect` is a real dependency of this package for those two paths
 * only.
 *
 * Note the TOP-LEVEL `import type` form above. The inline form — `import { type Marketplace }
 * from "@opencode-ai/core/marketplace"` — is NOT equivalent under `verbatimModuleSyntax`:
 * it still emits a real runtime `import {} from "@opencode-ai/core/marketplace"`, which
 * pulls `effect` in while passing a naive "does it say `type`?" review.
 *
 * VERIFIED EMPIRICALLY (C-001) — this closes F-001's open bundle-sanity AC; do not
 * re-litigate it. `wrangler` is still absent from this repo, but the AC's "or equivalent"
 * is satisfiable with Bun's own bundler and no deploy tooling:
 *
 *   bun build src/index.ts --target=browser --outdir=<tmp>
 *     -> Bundled 5 modules, index.js 4.35 KB
 *     -> grep -cE "effect|opencode-ai" <tmp>/index.js  ->  0
 *
 * Five modules is the entire Worker: index, router, response, db, handlers/marketplace-json.
 * `@opencode-ai/core` reaches db.ts as types only and is fully erased; `effect` never enters
 * the graph. Re-run that build after any new import in this file or under src/handlers/.
 */

/**
 * Deliberately thin: bind the real D1 read seam and hand the request to the router. All
 * dispatch, all cross-cutting 404/405/500 behavior and every handler live in `router.ts`
 * and `handlers/`, where they are testable against a fake `RegistryReadDb`.
 *
 * `d1ReadDb` construction is inert (it only closes over the binding), so an absent or
 * broken `env.MarketplaceRegistryDb` cannot throw HERE, outside the router's `try`/`catch`
 * — it surfaces on the first `prepare` call inside a handler and becomes the uniform 500.
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, d1ReadDb(env.MarketplaceRegistryDb))
  },
}
