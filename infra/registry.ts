////////////////
// DATABASE
////////////////

// XCOD-34 / story F-001.
//
// D1's `jurisdiction` is a CREATE-TIME-ONLY, IRREVERSIBLE setting: a database created in the
// wrong jurisdiction must be destroyed and recreated, never patched. Create-then-check is
// therefore not a valid fallback, and this ordering must never be reversed.
//
// FINDING (F-001's blocking AC, completed BEFORE any resource was created): CONFIRMED.
// SST's `transform.database` escape hatch passes straight through to the Pulumi Cloudflare
// provider's `D1DatabaseArgs`, which carries a native `jurisdiction: "eu" | "fedramp" | "us"`
// field. Because it is confirmed, this file takes the inline `sst.cloudflare.D1` path rather
// than the fallback (`wrangler d1 create --jurisdiction=eu` out-of-band, then reference via
// `sst.cloudflare.D1.get(...)`). Recorded in .claude/docs/xcod-34-registry-api-contracts.md.
//
// STILL OUTSTANDING on first deploy: independently confirm the EU jurisdiction
// post-creation via the Cloudflare dashboard or API — not merely assumed from the config
// used here.
const registryDb = new sst.cloudflare.D1("MarketplaceRegistryDb", {
  transform: {
    database: {
      jurisdiction: "eu",
    },
  },
})

////////////////
// WORKER
////////////////

// `url: true` yields a workers.dev dev/staging URL. There is deliberately NO custom
// `domain: registry.<domain>` here — a custom domain is XCOD-36's scope, not this story's.
//
// The D1 resource's SST logical name above ("MarketplaceRegistryDb") is what the linked
// binding surfaces as on `env` inside the Worker, so it must stay byte-identical to the
// `Env` key declared in packages/registry/src/index.ts. That SST-name -> env-key mapping is
// inferred by analogy to `sst.cloudflare.Kv("AuthStorage")` -> `env.AuthStorage` in
// packages/console/function/src/auth.ts; this repo has no D1 precedent, so it stays
// unconfirmed until F-001's deploy exercises it.
export const registry = new sst.cloudflare.Worker("MarketplaceRegistry", {
  handler: "packages/registry/src/index.ts",
  url: true,
  link: [registryDb],
})

////////////////
// INGESTION CRON (XCOD-35)
////////////////

// A dedicated `sst.cloudflare.Cron`, not a `scheduled` handler bolted onto the
// `MarketplaceRegistry` Worker above: `worker.handler` compiles to its OWN Worker bundle
// (per SST's Cron component), so packages/registry/src/ingest-worker.ts's `effect`
// dependency (via resolve.ts's `Marketplace.decode`) never reaches the read-API's fetch
// bundle — see ingest-worker.ts's own comment. Same D1 database linked as the read Worker,
// same "SST logical name -> env key" mapping convention as above (env.MarketplaceRegistryDb).
//
// Hourly by default (AC1 only requires "a fixed interval"; the ticket leaves the exact
// frequency to the hosting story's infra choice). Revisit if source count/GitHub API rate
// limits (60 req/hr unauthenticated) make hourly too aggressive once real sources are added.
export const registryIngestCron = new sst.cloudflare.Cron("MarketplaceRegistryIngestCron", {
  schedules: ["0 * * * *"],
  worker: {
    handler: "packages/registry/src/ingest-worker.ts",
    link: [registryDb],
  },
})
