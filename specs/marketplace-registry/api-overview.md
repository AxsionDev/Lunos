# XCOD-34: Marketplace Registry API (read endpoints)

## Overview

XCOD-34 implements the read-only HTTP API for the Lunos Marketplace Registry — a new Cloudflare
Worker + D1 service (`packages/registry`) that serves marketplace/plugin metadata to any client via
`marketplace add <url>` (XCOD-10), with zero new client-side code. This is the second of four
stories under epic XCOD-32 (Lunos Marketplace Registry Service, itself split out of XCOD-14/XCOD-7).

**Design authority:** `packages/opencode/specs/marketplace-registry.md` (XCOD-33, committed
`9b6f41296`) is the closed technical contract for hosting choice, API shapes, and the D1 jurisdiction
constraint. This doc captures what Discovery found in the _existing_ codebase that XCOD-34's
implementation must follow or reconcile with that spec — not a re-derivation of XCOD-33's decisions.

## Architecture & File Structure

### Precedent: `infra/console.ts` (the pattern to mirror)

```ts
const authStorage = new sst.cloudflare.Kv("AuthStorage")
export const auth = new sst.cloudflare.Worker("AuthApi", {
  domain: `auth.${domain}`,
  handler: "packages/console/function/src/auth.ts",
  url: true,
  link: [database, authStorage, GITHUB_CLIENT_ID_CONSOLE, GITHUB_CLIENT_SECRET_CONSOLE, GOOGLE_CLIENT_ID],
})

export const stat = new sst.cloudflare.Worker("Stat", {
  handler: "packages/console/function/src/stat.ts",
  link: [database],
  url: true,
})
```

- Handler style: plain default export `{ async fetch(request, env, ctx) {...} }`. **No router
  library** (no Hono/itty-router) anywhere in this repo's Workers — routing is manual
  `new URL(request.url).pathname` branching. The registry's 4-endpoint router should follow the
  same manual style.
- Bindings come in two flavors: raw Cloudflare bindings (KV/D1/R2) read off a per-file
  `type Env = { Binding: Type }` declared locally in the handler file (see `AuthStorage: KVNamespace`);
  or SST `Secret`/`Linkable` values read via the `Resource` proxy
  (`packages/console/resource/resource.cloudflare.ts`, reads `env.SST_RESOURCE_<name>`). D1 would
  follow the raw-binding pattern (`type Env = { MarketplaceRegistryDb: D1Database }`), by analogy —
  **not confirmed by an existing example**, since no D1 usage exists anywhere in this repo today.

### `packages/stats/` — layout precedent only, NOT a hosting-stack precedent

`packages/stats/` is real (`app/`, `core/`, `server/` subtrees) and is a valid precedent for
**directory layout / workspace registration** (multiple named subpackages under one directory, each
independently workspace-registered). Its actual infra (`infra/stats.ts`) is a SolidStart app on
Cloudflare backed by **PlanetScale MySQL**, plus a separate AWS ECS service — not Worker+D1. XCOD-33's
spec references "mirroring `packages/stats/` as its own tree" for layout only; its infra sketch
(`handler: "packages/registry/src/index.ts"`) actually implies a **flat** package, which contradicts
that "own tree" phrasing. **This is an internal inconsistency in the XCOD-33 spec** — resolve before
scaffolding (see Implementation Notes below for the resolution taken).

### Monorepo conventions for the new package

- `package.json`: `"$schema": "https://json.schemastore.org/package.json"`, `"private": true`,
  `"type": "module"`, `scripts.typecheck: "tsgo --noEmit"`, workspace deps as `"workspace:*"`,
  shared deps via root `catalog:` (includes `@cloudflare/workers-types`).
- `tsconfig.json`: Worker packages extend `@tsconfig/node22/tsconfig.json` (not `@tsconfig/bun`,
  used by pure-Bun packages like `packages/core`), `module: "ESNext"`, `moduleResolution: "bundler"`,
  `types: ["@cloudflare/workers-types", "bun", "node"]`.
- `sst-env.d.ts` is SST-auto-generated on `sst dev`/`sst build` — never hand-written.
- **Workspace registration gap:** root `package.json`'s `workspaces.packages` is
  `["packages/*", "packages/console/*", "packages/stats/*", "packages/sdk/js", "packages/slack"]`.
  A flat `packages/registry` is auto-discovered via `packages/*`. A nested layout
  (`packages/registry/{app,core,function}`) would need an explicit `"packages/registry/*"` entry —
  not automatic, and not mentioned in XCOD-33's spec.
- `turbo.json` registers per-package test tasks by exact package name; turbo still runs `test` on
  any package with a `test` script by default even without an explicit entry.

## Dependencies (internal)

- **`@opencode-ai/core/marketplace`** (`packages/core/src/marketplace.ts`, XCOD-8) — Effect `Schema`
  definitions, exact code:

```ts
export class Owner extends Schema.Class<Owner>("Marketplace.Owner")({
  name: Schema.String,
  email: Schema.String.pipe(Schema.optional),
  url: Schema.String.pipe(Schema.optional),
}) {}

export class NpmSource extends Schema.Class<NpmSource>("Marketplace.NpmSource")({
  type: Schema.Literal("npm"),
  package: Schema.String,
  version: Schema.String.pipe(Schema.optional),
}) {}

export class GithubSource extends Schema.Class<GithubSource>("Marketplace.GithubSource")({
  type: Schema.Literal("github"),
  repo: Schema.String,
  ref: Schema.String.pipe(Schema.optional),
}) {}

export const Source = Schema.Union([NpmSource, GithubSource]).pipe(Schema.toTaggedUnion("type"))
export type Source = typeof Source.Type

export class Entry extends Schema.Class<Entry>("Marketplace.Entry")({
  name: Schema.String,
  source: Source,
  description: Schema.String.pipe(Schema.optional),
  version: Schema.String.pipe(Schema.optional),
  author: Schema.String.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  tags: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

export class Manifest extends Schema.Class<Manifest>("Marketplace.Manifest")({
  $schema: Schema.String.pipe(Schema.optional),
  name: Schema.String,
  owner: Owner,
  description: Schema.String.pipe(Schema.optional),
  version: Schema.String.pipe(Schema.optional),
  plugins: Entry.pipe(Schema.Array),
}) {}

export const decode = Schema.decodeUnknownSync(Manifest)
```

**Validation is Effect `Schema`, not zod/valibot.** The registry package must depend on `effect`
and reuse `Marketplace.decode`/`Manifest`/`Entry`/`Source` — no redefinition. Note: no existing
Worker in this repo currently imports `effect`; bundling it into a Workers runtime is untested here.

- **`packages/opencode/src/plugin/discover.ts`** (XCOD-11) — `listPlugins`/`searchPlugins`:

```ts
export async function searchPlugins(query, ctx, dep = defaultMarketplaceListDeps) {
  const { marketplaceCount, marketplaces, plugins } = await listPlugins(ctx, dep)
  const needle = query.trim().toLowerCase()
  const matches = plugins.filter((item) => {
    const haystack = [item.name, item.description ?? "", item.category ?? "", ...(item.tags ?? [])]
    return haystack.some((value) => value.toLowerCase().includes(needle))
  })
  return { marketplaceCount, marketplaces, plugins: matches }
}
```

Confirms XCOD-33's claim: case-insensitive substring match against `name`, `description`,
`category`, `tags` only. **Divergence to account for:** `listPlugins`'s output type
(`PluginListEntry`) carries a pre-computed `spec: string` (via `pluginInstallSpec`), collapsing the
raw `Marketplace.Source` union into an install-spec string. The registry's `GET /plugins` response
shape (per XCOD-33) instead returns the **raw** `source` object. So "reuse `listPlugins`/
`searchPlugins`" means reuse the _matching logic_, not the _types_ — the registry needs its own
analogous flattening that preserves `source` raw.

- **`packages/opencode/src/marketplace/shared.ts`** — `resolveMarketplaceManifest` fetches raw text,
  `JSON.parse`s it, decodes via `Marketplace.decode`. No envelope. Confirms `GET /marketplace.json`
  must be a bare `Marketplace.Manifest` document at that exact path — any extra wrapper breaks
  `marketplace add <registry-url>/marketplace.json`.

- **Root `marketplace.json`** (XCOD-9 seed) — `{ name: "lunos-community", owner, description,
version, plugins: [...] }`, 32 entries, **all `source.type: "github"`** — no `npm`-type entries in
  the real seed today, and `category`/`tags` are universally absent. Test fixtures exercising those
  fields (XCOD-33's own example JSON uses `npm` + `category` + `tags`) need synthetic data, not the
  real seed.

## Testing Conventions

Framework: **`bun:test`** exclusively — no vitest, no jest, anywhere in the repo. Two patterns:

1. **DI style** for I/O-touching code (`marketplace.test.ts`, `shared.ts`'s `FetchDeps`/
   `MarketplaceListDeps`): production code takes a `dep` param defaulting to a real implementation;
   tests pass a fake. Filesystem tests use `await using tmp = await tmpdir()`
   (`packages/opencode/test/fixture/fixture.ts`), not `fs` mocking.
2. **Plain pure-function tests** (`packages/console/function/src/auth-redirect.test.ts`) —
   `describe`/`test`/`expect`, no fixtures, for pure logic.

**Gap: no D1/SQLite-backed Worker test pattern exists anywhere in this repo** (zero hits for
`miniflare`, `@cloudflare/vitest-pool-workers`, `D1Database`). XCOD-34 must either (a) keep D1 access
behind a thin DI-testable seam so unit tests use a fake "database" dependency (consistent with
pattern 1, no new toolchain), or (b) introduce `@cloudflare/vitest-pool-workers` — which also means
introducing vitest into a bun:test-only repo. **(a) is the lower-risk default** given the repo's
existing conventions; only reach for (b) if XCOD-34's endpoint logic can't reasonably be tested
without a live D1 binding.

## Integration Touchpoints

- `marketplace add <registry-url>/marketplace.json` (XCOD-10, unmodified) is the client-side
  integration point — no new client code, verified structurally by Discovery.
- The registry's dataset is seeded from XCOD-9's root `marketplace.json` (this story) and later kept
  fresh by XCOD-35's ingestion job (out of scope here).
- `packages/core` becomes a `workspace:*` dependency of the new `packages/registry` package, for the
  shared schema/decoder.

## Key Patterns Identified

- Manual URL-path routing, no router dependency, matching every existing Worker in this repo.
- `type Env = {...}` declared locally per Worker file, not derived from `sst-env.d.ts` (that file
  only covers SST `Resource`-proxy values, not raw Cloudflare bindings like D1/KV).
- Worker packages use `@tsconfig/node22` + `@cloudflare/workers-types`, diverging from the rest of
  the (Bun-first) monorepo's `@tsconfig/bun` convention — intentional, not an inconsistency to fix.

## Complexity Areas / Risks (beyond what XCOD-33's spec called out)

1. **XCOD-34 is the first D1 usage in this codebase, full stop** — no existing SST+D1 wiring, no
   `D1Database`-typed `Env`, no D1 migration/schema pattern, no local-dev D1 binding precedent to
   copy. XCOD-33's spec correctly flagged the jurisdiction-plumbing risk, but the surface is broader:
   everything about D1 here is being established for the first time.
2. **No D1 test pattern exists** — resolved above (default to DI seam over introducing vitest).
3. **Spec's flat-vs-nested package layout is internally inconsistent** — resolved below.
4. **`PluginListEntry` type mismatch** — resolved above (reuse matching logic, not the type).
5. **Seed data doesn't exercise `npm`/`category`/`tags` branches** — test fixtures need synthetic
   entries covering those fields, not just the real seed file.
6. **`effect` bundled into a Workers runtime is untested in this repo** — worth a quick build-size/
   compat sanity check early in implementation, not left to discovery at deploy time.

## Implementation Notes (decisions made after Discovery, before Phase 2/3)

- **Package layout: flat `packages/registry`**, not nested (`packages/registry/{app,core,...}`).
  This matches the spec's own infra sketch (`handler: "packages/registry/src/index.ts"`), requires
  no `workspaces.packages` glob change, and there's no evidence yet of a second sub-package (a CLI,
  a separate app) that would justify the `packages/stats/`-style nested layout. Revisit only if
  XCOD-35/36 introduce a genuinely separate deployable unit.

## Agent Implementation Notes

- Reuse `Marketplace.decode`/`Entry`/`Source`/`Manifest` from `@opencode-ai/core/marketplace` — do
  not redefine schema.
- Reuse `searchPlugins`'s matching predicate logic (case-insensitive substring over name/description/
  category/tags) but write registry-native flattening that preserves raw `source`.
- No router library — manual `pathname` branching per this repo's existing Worker convention.
- D1 access behind a DI seam for testability; defer any D1-binding-dependent test to local `sst dev`
  verification, not unit tests.
- `GET /marketplace.json` response must decode cleanly via `Marketplace.decode` with zero extra
  fields at the top level.
