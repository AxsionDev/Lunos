# Registry D1 migrations

Numbered raw SQL files for the XCOD-34 registry database (`MarketplaceRegistryDb`). Apply them in
filename order; `0001_init.sql` is the initial schema.

Every column maps to a field defined in `packages/core/src/marketplace.ts` (XCOD-8) — the manifest
schema is **never redefined here**, only derived from. The two exceptions are marked
`REGISTRY-NATIVE` in the DDL: `marketplace.source` (where the registry resolved the manifest from)
and `plugin.marketplace_name` (the denormalized parent name, mirroring `PluginListEntry.marketplace`
in `packages/opencode/src/plugin/discover.ts`).

## No ORM — raw SQL, decided deliberately

The repo's two existing Drizzle setups are neither reusable here: `@opencode-ai/console-core/drizzle`
is MySQL/PlanetScale-flavoured, and `packages/core` uses `@opencode-ai/effect-drizzle-sqlite` against
local SQLite files, not a D1 driver. Standing up `drizzle-orm/d1` plus a second `drizzle-kit` config
for **two tables and four trivially simple SELECTs** is pure overhead, and it adds weight to a Worker
bundle whose size is already flagged as an unverified risk. The DI seam in `../src/db.ts`
(`RegistryReadDb` / `RegistryWriteDb`) already provides the abstraction an ORM would be bought for.

Revisit only if XCOD-35 grows the schema materially.

## Applying these — deferred to deploy time, on purpose

**The exact `wrangler` invocation is not pinned here, because it has never been run against this
repo.** There is no `wrangler` dependency and no D1 precedent anywhere in the workspace today, and
F-002 had no D1 database to run against, so any command written down now would be an untested guess
dressed up as documentation. No `wrangler` devDependency was added for this story either: with no
database to reach, it would buy zero verification and only dirty the lockfile.

The _file_ is the contract; the _command_ is not. Two candidates, to be chosen and then recorded here
at first deploy:

1. **`wrangler d1 migrations apply <db> --remote`** — needs a minimal `wrangler.jsonc` declaring
   `migrations_dir: "migrations"` and the `d1_databases` binding. Tracks applied migrations for you,
   which is the reason to prefer it once there is more than one file.
2. **`wrangler d1 execute <db> --remote --file=migrations/0001_init.sql`** — no extra config, but no
   applied-migration bookkeeping either, so re-running is on you. The `CREATE TABLE IF NOT EXISTS`
   guards in `0001_init.sql` make that safe for this file specifically.

The **seed** script (`../src/seed.ts`) is a separate concern from schema migration and has its own
deferred transport decision — see the `d1HttpWriteDb` doc comment there, and §2.4 of
`.claude/docs/xcod-34-registry-api-contracts.md`.

## Deliberate omissions

| Omitted                      | Why                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Manifest.$schema`           | A JSON-schema editor hint on the _source document_, not data about the marketplace. No endpoint response includes it.                                                                                                                                                                                    |
| `ingested_at` / `created_at` | No endpoint exposes it. XCOD-35's refresh job can add it in `0002_*.sql` — that is what numbered migrations are for.                                                                                                                                                                                     |
| Any index beyond the PKs     | `PRIMARY KEY (marketplace_name, name)` creates an implicit index with `marketplace_name` leading, already covering per-marketplace lookups, the `pluginCount` aggregate, and the `ORDER BY marketplace_name, name`. A separate `plugin(marketplace_name)` index would be redundant — **do not add one.** |
| `STRICT` table modifier      | D1's support for it is unverified and every column here is `TEXT` anyway. Not worth a migration that might fail on an unverified feature.                                                                                                                                                                |
| `PRAGMA foreign_keys = ON`   | D1 restricts which PRAGMAs are accepted. Omitted rather than risk a failing migration. Instead, `buildReplaceStatements`'s statement order satisfies the FK constraint natively: children deleted before the parent, the parent inserted before its children.                                            |
