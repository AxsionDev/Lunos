# Stories for: XCOD-34 Registry API (read endpoints)

## Overview

- **Total Stories:** 6
- **Complexity Distribution:** S: 2, M: 2, L: 2, XL: 0
- **Discovery Doc:** `.claude/docs/xcod-34-registry-api.md`
- **User Journeys:** `.claude/docs/xcod-34-registry-api-user-journeys.md`
- **Design Authority:** `packages/opencode/specs/marketplace-registry.md` (XCOD-33)
- **Generated:** 2026-09-14

**Scope note:** XCOD-34 is one Jira story (4 read-only HTTP endpoints, no UI, a single new flat
package `packages/registry`) implemented in one working session by one or two developer agents —
not a multi-team epic. The phase structure below deliberately collapses the standard 5-phase
template (Foundation/Core/Integration/Secondary/Polish) into 3 phases that carry real sequencing
weight for a story this size: **Foundation** (infra + data), **Core** (the router and its 4
endpoints), **Verification** (no-new-code confirmation + AC smoke test). There is no dedicated
"Integration" or "Polish" phase because this package has no frontend to wire to and no error-path
work that isn't already an acceptance criterion on the story that builds the router/endpoint it
belongs to.

## Two decisions already applied (not re-litigated in this doc)

- **GAP-001:** `GET /plugins/search` — absent `q` → `400 Bad Request`. Present-but-empty/whitespace
  `q` → `200` with all plugins (mirrors client `trim().toLowerCase()` → `includes("")` → always true).
- **GAP-002:** `GET /marketplace.json`'s fixed top-level identity: `name: "lunos-registry"`,
  `owner: { name: "Lunos", url: "https://github.com/pminev1/Lunos" }`. Note: the `owner` block is
  byte-identical to the seed `marketplace.json`'s own `owner` — the `name` field
  (`"lunos-registry"` vs. the seed's `"lunos-community"`) is what must actually differ, and every
  story below tests it as a literal constant, not a value carried through from seeded rows.

## Journey-to-Story Coverage Matrix

| Journey ID | Journey Title | Stories | Coverage |
|------------|----------------|---------|----------|
| ADMIN-001 | Provision the D1 database and Worker (dev/staging) | F-001 | Yes |
| ADMIN-002 | Seed D1 from the root `marketplace.json` | F-002 | Yes |
| APIC-004 | `GET /marketplace.json` | C-001 | Yes |
| EUSR-001 | Add the registry as a marketplace source | C-001, V-001 | Yes |
| APIC-001 | `GET /marketplaces` | C-002 | Yes |
| APIC-002 | `GET /plugins` | C-002 | Yes |
| APIC-003 | `GET /plugins/search?q=<query>` | C-003 | Yes |
| EUSR-002 | List plugins from a registry-backed marketplace | V-001 | Yes |
| EUSR-003 | Search plugins locally against registry-backed cache | V-001 | Yes |
| ADMIN-003 | Verify deployment against XCOD-34's acceptance criteria | V-001 | Yes |

**Coverage: 10 / 10 journeys (100%)**

---

## Phase 1: Foundation Stories

### Story F-001: Provision the D1 database (EU jurisdiction) and deploy the Worker

**Objective:** Stand up `packages/registry` as a scaffolded Cloudflare Worker package wired to an
EU-jurisdiction D1 database via SST, deployed and reachable in dev/staging, with the
irreversible jurisdiction decision verified before any resource is created.

**Complexity:** L

**Journey References:** ADMIN-001

**Prerequisites:** None

**Acceptance Criteria:**
- [ ] **Blocking, must run first:** before creating any D1 resource, confirm whether
      `sst.cloudflare.D1`'s `transform.database` escape hatch actually plumbs `jurisdiction: "eu"`
      through to the underlying Cloudflare `D1DatabaseArgs` (check SST source/docs and the
      Cloudflare provider resource — this is a read-only verification step, not an assumption).
      Document the finding (confirmed / not confirmed) in the PR description or a code comment in
      `infra/registry.ts` before proceeding to the next AC.
- [ ] If confirmed: create the D1 database inline in a new `infra/registry.ts` via
      `sst.cloudflare.D1("MarketplaceRegistryDb", { transform: { database: { jurisdiction: "eu" } } })`.
- [ ] If **not** confirmed: create the database out-of-band via `wrangler d1 create --jurisdiction=eu`
      and reference it in SST via `sst.cloudflare.D1.get(...)` — do **not** create it inline in this
      branch. State explicitly in `infra/registry.ts` (comment) that jurisdiction is a create-time-only,
      irreversible setting, so this ordering must never be reversed (create-then-check is not a valid
      fallback — a wrongly-jurisdictioned DB must be destroyed and recreated, not patched).
- [ ] Define the Worker: `sst.cloudflare.Worker("MarketplaceRegistry", { handler:
      "packages/registry/src/index.ts", url: true, link: [registryDb] })` — `url: true` for a
      `workers.dev` dev/staging URL; do **not** provision a custom `domain: registry.<domain>`
      (that's XCOD-36 scope).
- [ ] Scaffold flat package `packages/registry` (not nested `packages/registry/{app,core,...}` — see
      Discovery's resolved layout decision): `package.json` with `"$schema":
      "https://json.schemastore.org/package.json"`, `"private": true`, `"type": "module"`,
      `scripts.typecheck: "tsgo --noEmit"`, `@opencode-ai/core` as a `"workspace:*"` dependency,
      `effect` as a direct dependency (see next AC); `tsconfig.json` extending
      `@tsconfig/node22/tsconfig.json` with `module: "ESNext"`, `moduleResolution: "bundler"`,
      `types: ["@cloudflare/workers-types", "bun", "node"]`. No change to root
      `workspaces.packages` needed — flat layout auto-discovers via the existing `"packages/*"` glob.
- [ ] Do a build-size/compatibility sanity check that bundling `effect` (required to reuse
      `Marketplace.decode`) into a Cloudflare Workers runtime actually works — this repo has zero
      existing Workers that import `effect`. Run/attempt a build (`wrangler deploy --dry-run` or
      equivalent) and confirm it succeeds before other stories depend on it; flag and resolve any
      bundle-size or runtime-compat failure here, not at deploy time in a later story.
- [ ] `packages/registry/src/index.ts` exists as a minimal placeholder handler (`export default {
      async fetch(request, env, ctx) {...} }`, no router library — manual `pathname` branching per
      this repo's existing Worker convention, e.g. `packages/console/function/src/auth.ts:45-46`) so
      the Worker deploys successfully; full routing is C-001's scope, not this story's.
- [ ] `sst dev` / `sst deploy` succeeds; the Worker is reachable over HTTPS at its `workers.dev` URL;
      the D1 binding resolves at runtime without error (`type Env = { MarketplaceRegistryDb:
      D1Database }` declared locally in `index.ts`, by analogy to `AuthStorage: KVNamespace` in
      `auth.ts` — this repo's first D1 binding, no existing precedent to copy verbatim).
- [ ] D1's EU jurisdiction is independently confirmed post-creation (Cloudflare dashboard or API),
      not just assumed from the creation command/config used.

**Technical Notes:**
- Patterns to follow: `infra/console.ts` (`AuthApi`, `Stat` worker constructs) is the precedent for
  `infra/registry.ts`; `packages/console/function/src/auth.ts` for the local `type Env = {...}`
  binding-declaration style.
- Key files: `infra/registry.ts` (new), `packages/registry/package.json` (new),
  `packages/registry/tsconfig.json` (new), `packages/registry/src/index.ts` (new, placeholder).
- Integration points: links `packages/core` (`@opencode-ai/core/marketplace`) as a workspace
  dependency for later stories' use of `Marketplace.decode`/`Manifest`/`Entry`/`Source`.
- Risk callouts from Discovery: this is the first D1 usage in the codebase (no existing
  D1-binding `Env`, no migration pattern, no local-dev D1 precedent) — expect to resolve small
  unknowns empirically rather than by copying an existing example.

**Agent Command:** `/feature xcod-34-registry-api - Story F-001`

---

### Story F-002: D1 schema, migrations, and decode-before-write seed script

**Objective:** Define the D1 marketplace/plugin tables and a seed script that validates the root
`marketplace.json` via `Marketplace.decode` before writing a single row, so invalid seed data can
never reach the database.

**Complexity:** M

**Journey References:** ADMIN-002

**Prerequisites:** F-001 (D1 database and binding must exist)

**Acceptance Criteria:**
- [ ] D1 schema/migration defines a `marketplace` table (one row per ingested manifest — one row
      after this story's seed run: `lunos-community`) and a `plugin` table (one row per plugin
      entry, denormalized with its parent marketplace's `name`, per the spec's data-seed-mapping
      section — mirrors how `listPlugins` flattens plugins with a `marketplace` field client-side).
      Migration mechanism choice (raw `wrangler d1 migrations` SQL files vs. an ORM) is this story's
      to decide; document the choice in the migration directory's README or a code comment.
- [ ] Seed script reads repo-root `marketplace.json` and decodes it via `Marketplace.decode`
      (`Schema.decodeUnknownSync(Manifest)` from `@opencode-ai/core/marketplace`) **before any row
      is written** — this is the only point in the system where schema-invalid seed data can be
      caught (a Worker has no startup/boot hook).
- [ ] On decode success: insert one marketplace row + one plugin row per entry, as a single D1
      batch/transaction (not one-insert-per-row) to avoid a partial-write state if the batch fails
      mid-way.
- [ ] On decode failure: seed aborts, writes nothing, D1 is left in its prior state (empty on first
      run). Script exits non-zero / surfaces the decode error clearly.
- [ ] After a successful run against the real seed file: D1 has exactly 1 marketplace row and a
      plugin-row count equal to `marketplace.json`'s current `plugins.length` (32 at Discovery time —
      assert this is read from the file at seed time, not hardcoded as a test constant).
- [ ] Unit test (`bun:test`) exercises the decode-before-write gate using a fake/DI-injected D1
      dependency and a synthetic invalid manifest (e.g. missing required `name`) — asserts zero
      writes occur. Uses the DI seam from C-001/F-001, not a live D1 binding.

**Technical Notes:**
- Patterns to follow: DI style for I/O-touching code per Discovery's testing conventions — seed
  script takes a `dep` param defaulting to the real D1 binding, tests pass a fake, consistent with
  `marketplace.test.ts`'s pattern in `packages/opencode`.
- Key files: `packages/registry/src/db/schema.sql` or equivalent migration file(s) (new),
  `packages/registry/src/seed.ts` (new), `packages/registry/src/seed.test.ts` (new).
- Integration points: reuses `Marketplace.decode`/`Manifest`/`Entry`/`Source` from
  `@opencode-ai/core/marketplace` (`packages/core/src/marketplace.ts`) — do not redefine schema.
  Reads repo-root `marketplace.json` (XCOD-9 seed, all `source.type: "github"`, no `npm`/
  `category`/`tags` examples in the real data — synthetic fixtures needed for those branches, see
  C-002/C-003 test notes).
- Note for reviewers: `owner` in the seed file is `{ name: "Lunos", url:
  "https://github.com/pminev1/Lunos" }` — same values as GAP-002's fixed registry identity, but a
  **different field** (`name: "lunos-community"` at the manifest level vs. GAP-002's
  `name: "lunos-registry"`). Do not conflate the seeded marketplace's identity with the registry's
  own fixed identity (that distinction is C-001's concern for `GET /marketplace.json`).

**Agent Command:** `/feature xcod-34-registry-api - Story F-002`

---

## Phase 2: Core Implementation Stories

### Story C-001: Manual router, D1 DI seam, and `GET /marketplace.json`

**Objective:** Build the Worker's manual pathname router and a DI-testable seam over D1, then
implement the highest-priority endpoint — `GET /marketplace.json` — since it's the only endpoint
any real client (`marketplace add`, EUSR-001) actually calls and what XCOD-34's/XCOD-36's ACs
verify against.

**Complexity:** L

**Journey References:** APIC-004, EUSR-001

**Prerequisites:** F-001, F-002

**Acceptance Criteria:**
- [ ] `packages/registry/src/index.ts` implements manual `new URL(request.url).pathname` branching
      (no Hono/itty-router or any router dependency) for all 4 endpoint paths
      (`/marketplaces`, `/plugins`, `/plugins/search`, `/marketplace.json`) — this story wires the
      routing skeleton for all 4 even though only `/marketplace.json`'s handler is implemented here;
      C-002/C-003 fill in the remaining handlers.
- [ ] Router-level cross-cutting behavior (applies to all 4 endpoints, tested here since this is
      where the router lives): unmatched path → `404`; matched path + wrong HTTP method → `405
      Method Not Allowed` (mirrors `packages/console/function/src/stat.ts`'s existing `if
      (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 })`
      precedent — GAP-004's resolution).
- [ ] D1 access sits behind a DI-testable seam (a function/object param defaulting to the real
      `env.MarketplaceRegistryDb` binding, overridable with a fake in tests) — consistent with
      Discovery's resolved testing approach (default to DI seam, no `miniflare`/
      `@cloudflare/vitest-pool-workers`).
- [ ] `GET /marketplace.json` queries D1 for every plugin across every ingested marketplace and
      assembles a bare `Marketplace.Manifest` document (`name`, `owner`, `description`, `version`,
      `plugins: Entry[]`), reusing `Marketplace.Manifest`/`Entry`/`Source` from
      `@opencode-ai/core/marketplace` — no redefinition.
- [ ] The manifest's top-level `name` is the literal fixed constant `"lunos-registry"` and `owner`
      is the literal fixed constant `{ name: "Lunos", url: "https://github.com/pminev1/Lunos" }`
      (GAP-002) — **never** derived from, or equal to, any single seeded marketplace row's own
      `name`/`owner` fields. Add a unit test that seeds a fake DB with a marketplace whose `name` is
      something other than `"lunos-registry"` (e.g. `"lunos-community"`) and asserts the response's
      top-level `name` is still `"lunos-registry"` — this specifically catches a pass-through bug
      where the seeded manifest's identity leaks into the aggregate response.
- [ ] Response has zero extra top-level fields beyond the `Marketplace.Manifest` shape (any wrapper
      breaks `resolveMarketplaceManifest`'s client-side `Marketplace.decode` call).
- [ ] Empty-D1 case: `200` with `plugins: []` (a valid, schema-conformant empty array), never `404`.
- [ ] D1 query failure / binding unavailable: `5xx` with a `{ "error": string }` JSON body
      (GAP-003's working default).
- [ ] Unit test (`bun:test`, fake D1 dependency) asserts the happy-path response round-trips
      cleanly through `Marketplace.decode` with no errors — this is XCOD-34's Jira AC #2 at the unit
      level (ADMIN-003 repeats it as a live smoke check in V-001, not a duplicate of this test).

**Technical Notes:**
- Patterns to follow: `packages/console/function/src/auth.ts:45-46` for pathname-branch style;
  `packages/console/function/src/stat.ts` for the 405 precedent.
- Key files: `packages/registry/src/index.ts`, `packages/registry/src/db.ts` (DI seam, new),
  `packages/registry/src/handlers/marketplace-json.ts` (or inline in `index.ts` — developer's
  call), `packages/registry/src/index.test.ts` / `marketplace-json.test.ts` (new).
- Integration points: `@opencode-ai/core/marketplace` (`Marketplace.decode`, `Manifest`, `Entry`,
  `Source`) from `packages/core/src/marketplace.ts`. Client-side counterpart this endpoint must
  satisfy: `resolveMarketplaceManifest` in `packages/opencode/src/marketplace/shared.ts`.
- Reuse note: reuse the *matching/flattening logic pattern* from `listPlugins`
  (`packages/opencode/src/plugin/discover.ts`), not its `PluginListEntry` type — that type
  collapses `source` into an install-spec string, but this endpoint (and C-002) must preserve the
  raw `Marketplace.Source` union.

**Agent Command:** `/feature xcod-34-registry-api - Story C-001`

---

### Story C-002: `GET /marketplaces` and `GET /plugins`

**Objective:** Implement the two remaining registry-native listing endpoints, reusing the router
skeleton and D1 DI seam from C-001.

**Complexity:** M

**Journey References:** APIC-001, APIC-002

**Prerequisites:** C-001

**Acceptance Criteria:**
- [ ] `GET /marketplaces` returns `200 { "marketplaces": [{ name, owner, description, pluginCount,
      source }] }` — one entry per row in the marketplace table; `pluginCount` is derived
      (aggregated from the plugin table), not a stored manifest field.
- [ ] `GET /marketplaces` empty-D1 case: `200 { "marketplaces": [] }`, never `404`.
- [ ] `GET /plugins` returns `200 { "plugins": [{ name, marketplace, description, category, tags,
      source }] }` — full flattened list across all marketplaces, `source` preserved as the raw
      `Marketplace.Source` tagged union (not collapsed to an install-spec string — see C-001's reuse
      note on `listPlugins`/`PluginListEntry`).
- [ ] `GET /plugins` empty-D1 case: `200 { "plugins": [] }`, never `404`.
- [ ] Both endpoints: D1 query failure → `5xx` with the same `{ "error": string }` envelope as
      C-001 (GAP-003), and inherit C-001's router-level `404`/`405` behavior (no per-endpoint
      reimplementation).
- [ ] Unit tests (`bun:test`, fake D1 dependency) cover: happy path against seeded fixture data
      (including at least one synthetic entry with `source.type: "npm"`, `category`, and `tags` set,
      since the real seed file has none of these — per Discovery's flagged gap), empty-D1 case, and
      D1-failure case, for both endpoints.

**Technical Notes:**
- Patterns to follow: same router/DI-seam conventions established in C-001; same file-per-handler
  or inline style chosen there.
- Key files: `packages/registry/src/handlers/marketplaces.ts`, `packages/registry/src/handlers/plugins.ts`
  (or equivalent per C-001's structure), plus corresponding `*.test.ts` files.
- Integration points: shares the plugin/marketplace D1 tables from F-002; shares the pathname
  router and DI seam from C-001 — this story only adds handlers, it does not touch routing
  infrastructure.

**Agent Command:** `/feature xcod-34-registry-api - Story C-002`

---

### Story C-003: `GET /plugins/search?q=<query>`

**Objective:** Implement server-side search as a thin filter over C-002's `GET /plugins` query,
applying GAP-001's resolution for absent vs. empty `q`.

**Complexity:** S

**Journey References:** APIC-003

**Prerequisites:** C-002 (reuses its query/flattening logic)

**Acceptance Criteria:**
- [ ] `GET /plugins/search` with **no** `q` parameter at all → `400 Bad Request` (GAP-001).
- [ ] `GET /plugins/search?q=` (present, empty or whitespace-only) → `200`, all plugins returned —
      matches client `searchPlugins`'s `needle = "".toLowerCase()` → `includes("")` → always-true
      behavior exactly (GAP-001).
- [ ] `GET /plugins/search?q=<non-empty>` filters case-insensitively over `name`, `description`,
      `category`, and `tags` **only** — explicitly not `author`, not `marketplace` (matches the
      client's `searchPlugins` haystack exactly, per Discovery's confirmed reuse of that matching
      logic).
- [ ] No matches → `200 { "plugins": [] }`, never `404` (matches client's "no plugins matched"
      semantics, per spec).
- [ ] Response shape identical to `GET /plugins` (C-002), scoped to matches.
- [ ] D1 query failure → `5xx` with the `{ "error": string }` envelope; inherits router-level
      `404`/`405` from C-001.
- [ ] Unit tests (`bun:test`, fake D1 dependency) cover: absent `q` → 400; empty `q` → all results;
      non-empty `q` matching each of name/description/category/tags individually; non-empty `q`
      matching `author` or `marketplace` only → asserts **no** match (guards the explicit
      author/marketplace exclusion); no-match case → empty array, 200.

**Technical Notes:**
- Patterns to follow: `searchPlugins` (`packages/opencode/src/plugin/discover.ts` ~L130-137) for
  the exact matching-field set and case-insensitive substring logic to mirror server-side.
- Key files: `packages/registry/src/handlers/plugins-search.ts` (or equivalent), corresponding
  `*.test.ts`.
- Integration points: filters over the same plugin data C-002's `GET /plugins` reads — reuse that
  query, don't duplicate it.

**Agent Command:** `/feature xcod-34-registry-api - Story C-003`

---

## Phase 3: Verification Stories

### Story V-001: Client-path verification and deployment AC smoke test

**Objective:** Confirm the End User journeys (`marketplace add`/`list`/`search`) work against the
deployed registry with zero new client-side code, and run the final smoke test against XCOD-34's
Jira acceptance criteria.

**Complexity:** S

**Journey References:** EUSR-001, EUSR-002, EUSR-003, ADMIN-003

**Prerequisites:** C-001, C-002, C-003

**Acceptance Criteria:**
- [ ] **Guardrail, verify before anything else:** no files under `packages/opencode/` (or any
      existing client package) are modified by this story or any prior story in this set. EUSR-001/
      002/003 are verification-only — the CLI's existing `marketplace add`/`list`/`search` code path
      is exercised unmodified against the new server. If any change to client code seems necessary
      to make these journeys pass, stop and treat it as a signal that an earlier story's contract is
      wrong, not something to patch here.
- [ ] EUSR-001: running `lunos marketplace add <workers.dev-url>/marketplace.json` against the
      deployed dev Worker succeeds — source is added to local config, manifest is cached, no error.
- [ ] EUSR-002: `lunos marketplace list` (or `plugin list`) after EUSR-001 shows the registry's
      plugins alongside any other configured sources.
- [ ] EUSR-003: `lunos marketplace search <query>` (or `plugin search`) filters correctly. Confirm
      via inspection/log or a network-request assertion that this command performs **zero** network
      calls to `/plugins/search` — `searchPlugins` filters the already-cached manifest entirely
      client-side; this journey must not be reinterpreted as "call the search endpoint."
- [ ] ADMIN-003: hit all 4 deployed endpoints over HTTPS (curl or scripted HTTP client) and confirm
      each returns `200` with the expected shape from its story's ACs above.
- [ ] ADMIN-003: programmatically round-trip the live `GET /marketplace.json` response through
      `Marketplace.decode` (not eyeballing JSON) — this is the actual satisfaction of Jira AC #2
      ("payloads validate against the XCOD-8 schema") at the live-deployment level, distinct from
      C-001's unit-test-level decode check.
- [ ] ADMIN-003: confirm live plugin/marketplace counts match the seed file's actual entry count at
      seed time (1 marketplace row; plugin row count equals root `marketplace.json`'s current
      `plugins.length` — read dynamically, not hardcoded).
- [ ] This verification is a manual/scripted smoke check (a shell script or documented curl
      sequence is sufficient), **not** a `bun:test` unit test suite requirement — per Discovery's
      resolved testing approach, live-D1 verification stays out of the unit test suite.

**Technical Notes:**
- Patterns to follow: none new — this story runs existing client code
      (`packages/opencode/src/marketplace/shared.ts`, `packages/opencode/src/plugin/discover.ts`,
      `packages/opencode/src/cli/cmd/marketplace.ts`) against the newly deployed server.
- Key files: no production code files expected to change. Optional: a `packages/registry/scripts/smoke-test.sh`
  (or similar) capturing ADMIN-003's curl + decode sequence for repeatability, since XCOD-36 will
  need an equivalent check against production later.
- Integration points: this is the end-to-end confirmation that C-001/C-002/C-003's contracts and
  F-001/F-002's infra/data actually compose correctly under the real client.

**Agent Command:** `/feature xcod-34-registry-api - Story V-001`

---

## Implementation Sequence

Recommended execution order with dependency notes (matches the user journeys doc's resolved
sequence):

1. **F-001** — jurisdiction verification, D1 + Worker provisioning. No dependencies; blocking and
   irreversible, so it must run first and its jurisdiction check must complete before any D1
   resource is created.
2. **F-002** — D1 schema + seed script. Depends on F-001's D1 binding existing.
3. **C-001** — router skeleton, D1 DI seam, `GET /marketplace.json`. Depends on F-001 (Worker/D1)
   and F-002 (data to query, and the schema the DI seam's fake must mirror). Highest-priority
   endpoint story — it's what EUSR-001 and XCOD-34's/XCOD-36's ACs depend on most directly.
4. **C-002** — `GET /marketplaces` + `GET /plugins`. Depends on C-001's router/DI-seam existing;
   can run in parallel with C-003 once C-001 is merged.
5. **C-003** — `GET /plugins/search`. Depends on C-002 (reuses its query/flattening logic) more
   than on C-001 directly; thin filter layer, smallest story in the set.
6. **V-001** — client-path verification + AC smoke test. Depends on C-001, C-002, and C-003 all
   being complete and deployed; this is the closing gate for XCOD-34, not implementation work.
