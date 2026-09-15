import type { D1Database, ExecutionContext, ScheduledController } from "@cloudflare/workers-types"
import { d1IngestionSourceDb, d1WriteDb } from "./db"
import { runIngestion } from "./ingest"
import { resolveSource } from "./resolve"

/**
 * XCOD-35's scheduled entry point — a SEPARATE Worker bundle from index.ts (the read-API
 * fetch handler), deployed via its own `sst.cloudflare.Cron` in infra/registry.ts, linked
 * to the same `MarketplaceRegistryDb` D1 database. Kept separate deliberately: this file
 * value-imports `resolveSource`, which value-imports `Marketplace` for real schema
 * validation, so `effect` legitimately enters THIS bundle. Folding ingestion into
 * index.ts's `fetch` handler would drag that cost into the hot request path index.ts's own
 * BUNDLE CONSTRAINT comment keeps effect-free — a background cron job has no such
 * constraint to violate.
 *
 * Same "declared locally, not sourced from sst-env.d.ts" convention and the same
 * unconfirmed-until-deploy status as index.ts's `Env` — see that file's comment.
 */
type Env = {
  MarketplaceRegistryDb: D1Database
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runIngestion({
      sources: d1IngestionSourceDb(env.MarketplaceRegistryDb),
      write: d1WriteDb(env.MarketplaceRegistryDb),
      resolve: resolveSource,
    })
  },
}
