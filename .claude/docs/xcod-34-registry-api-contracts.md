# XCOD-34 Registry API — Contracts

**Phase 3 (contract definition) output for XCOD-34.** Authoritative for the four things the stories
doc flags as still open. Everything else is already closed elsewhere and is **not** restated here:

| Already closed by | What it fixes |
|---|---|
| `packages/opencode/specs/marketplace-registry.md` (XCOD-33) | Hosting choice; the 4 endpoints' request/response JSON shapes |
| `.claude/stories/xcod-34-registry-api.md` | GAP-001 (absent vs. empty `q`), GAP-002 (fixed registry identity) |
| `packages/core/src/marketplace.ts` (XCOD-8) | The manifest/entry/source schema itself — **never redefined**, only derived from |

**Scope of this document:** (1) the D1 DDL, (2) the D1 DI seam's TypeScript interface, (3) the local
`Env` type, (4) the error envelope plus the router-level 404/405/500 literals. Plus one paragraph
justifying the `source` denormalization.

**Carried forward, already resolved — do not re-verify:** the D1 jurisdiction plumbing is
**CONFIRMED**. `sst.cloudflare.D1("MarketplaceRegistryDb", { transform: { database: { jurisdiction:
"eu" } } })` works — Cloudflare's `D1DatabaseArgs` (which SST's `transform.database` passes through
to) has a native `jurisdiction: "eu" | "fedramp" | "us"` field. **F-001 takes the inline
`sst.cloudflare.D1` path, not the `wrangler d1 create` fallback.** F-001's AC to verify jurisdiction
independently *post-creation* (dashboard/API) still stands.

---

## 1. D1 schema and migration mechanism

### 1.1 Migration mechanism — DECIDED: numbered raw SQL files, no ORM

**Artifact (fixed, all stories depend on it):** `packages/registry/migrations/0001_init.sql`, and
numbered siblings thereafter. No ORM, no `drizzle-kit` for D1.

Rationale: the repo's two existing Drizzle setups are neither reusable here —
`@opencode-ai/console-core/drizzle` is MySQL/PlanetScale-flavoured, and `packages/core` uses
`@opencode-ai/effect-drizzle-sqlite` against local SQLite files, not a D1 driver. Standing up
`drizzle-orm/d1` + a second `drizzle-kit` config for **two tables and four trivially simple
SELECTs** is pure overhead, and it adds weight to a Worker bundle whose size F-001 already flags as
an unverified risk. The DI seam (§2) already provides the abstraction an ORM would be bought for.
Revisit only if XCOD-35 grows the schema materially.

**The exact `wrangler` invocation is F-002's to determine empirically** — this repo has no
`wrangler` dependency and no D1 precedent. Candidates: `wrangler d1 migrations apply <db>` (needs a
minimal `wrangler.jsonc` declaring `migrations_dir`) or `wrangler d1 execute <db> --remote
--file=...`. Whichever is chosen, document it in `packages/registry/migrations/README.md` per
F-002's AC. The *file* is the contract; the *command* is not.

### 1.2 DDL

```sql
-- packages/registry/migrations/0001_init.sql
--
-- XCOD-34 registry schema. Every column below maps to a field defined in
-- packages/core/src/marketplace.ts (XCOD-8) — Marketplace.Manifest, .Owner, .Entry, .Source —
-- except the two explicitly marked "registry-native".

CREATE TABLE IF NOT EXISTS marketplace (
  -- Manifest.name. Natural key: one row per ingested manifest.
  name        TEXT PRIMARY KEY,

  -- Marketplace.Owner, flattened (closed 3-field shape: name required, email/url optional).
  owner_name  TEXT NOT NULL,
  owner_email TEXT,
  owner_url   TEXT,

  -- Manifest.description / Manifest.version (both Schema.optional in XCOD-8).
  description TEXT,
  version     TEXT,

  -- REGISTRY-NATIVE, not an XCOD-8 field: where the registry resolved this manifest from.
  -- Surfaced verbatim as `source` on GET /marketplaces (per XCOD-33's example response).
  source      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin (
  -- REGISTRY-NATIVE denormalization, per XCOD-33's data-seed-mapping section. Mirrors
  -- PluginListEntry.marketplace in packages/opencode/src/plugin/discover.ts.
  marketplace_name TEXT NOT NULL REFERENCES marketplace(name) ON DELETE CASCADE,

  -- Entry.name
  name             TEXT NOT NULL,

  -- Marketplace.Source, denormalized: discriminant column + per-variant columns. See §1.5.
  source_type      TEXT NOT NULL CHECK (source_type IN ('npm', 'github')),
  source_package   TEXT,  -- NpmSource.package    — required when source_type = 'npm'
  source_version   TEXT,  -- NpmSource.version    — optional
  source_repo      TEXT,  -- GithubSource.repo    — required when source_type = 'github'
  source_ref       TEXT,  -- GithubSource.ref     — optional

  -- Entry scalar optionals.
  description      TEXT,
  version          TEXT,  -- Entry.version — DISTINCT from source_version (NpmSource.version)
  author           TEXT,
  category         TEXT,

  -- Entry.tags: a JSON array of strings. NULL when the key is absent; '[]' is a distinct,
  -- legal value that round-trips as an empty array.
  tags             TEXT,

  PRIMARY KEY (marketplace_name, name),

  -- Enforces the tagged union's arity at write time: exactly the named variant's columns are
  -- populated and the other variant's are NULL. This is the write-time guard a JSON blob
  -- cannot provide (see §1.5).
  CHECK (
    (source_type = 'npm'
      AND source_package IS NOT NULL
      AND source_repo IS NULL AND source_ref IS NULL)
    OR
    (source_type = 'github'
      AND source_repo IS NOT NULL
      AND source_package IS NULL AND source_version IS NULL)
  )
);
```

### 1.3 Deliberate omissions (decisions, not oversights)

| Omitted | Why |
|---|---|
| `Manifest.$schema` | A JSON-schema editor hint on the *source document*, not data about the marketplace. No endpoint response includes it, and the registry's own `/marketplace.json` has its own fixed identity. |
| `ingested_at` / `created_at` | No endpoint exposes it. XCOD-35's refresh job can add it in `0002_*.sql` — that is what numbered migrations are for. YAGNI here. |
| Any index beyond the PKs | The composite `PRIMARY KEY (marketplace_name, name)` creates an implicit index with `marketplace_name` leading. It already covers per-marketplace lookups, the `pluginCount` aggregate, and the deterministic `ORDER BY marketplace_name, name`. A separate `plugin(marketplace_name)` index would be redundant — **do not add one.** |
| `STRICT` table modifier | Would be nice-to-have, but D1's support for it is unverified and every column here is `TEXT` anyway. Not worth a migration that might fail on an unverified feature. |
| `PRAGMA foreign_keys = ON` | D1 restricts which PRAGMAs are accepted. Omitted rather than risk a failing migration. Instead, the statement order in §2.4 satisfies FK constraints natively (parent inserted before children, children deleted before parent). |

### 1.4 Canonical read queries

Fixed here so C-001/C-002/C-003 don't each write their own:

```sql
-- RegistryReadDb.listMarketplaces()
SELECT m.name, m.owner_name, m.owner_email, m.owner_url, m.description, m.version, m.source,
       (SELECT COUNT(*) FROM plugin p WHERE p.marketplace_name = m.name) AS plugin_count
FROM marketplace m
ORDER BY m.name;

-- RegistryReadDb.listPlugins()
SELECT marketplace_name, name,
       source_type, source_package, source_version, source_repo, source_ref,
       description, version, author, category, tags
FROM plugin
ORDER BY marketplace_name, name;
```

`pluginCount` is computed by the correlated subquery above — **derived, never a stored column**
(C-002's AC). The search filter is applied in JS over `listPlugins()`'s result, not in SQL, because
C-003 must mirror the client's matching semantics exactly (see `matchesQuery` in §2.5).

### 1.5 Why `source` is denormalized into columns rather than stored as JSON

`Marketplace.Source` is `Schema.Union([NpmSource, GithubSource]).pipe(Schema.toTaggedUnion("type"))`
— a closed, two-variant tagged union whose variants carry two fields each (`npm`: `package`
required, `version` optional; `github`: `repo` required, `ref` optional). Both candidate encodings —
a single `source TEXT` column holding the serialized union, versus a `source_type` discriminant plus
nullable per-variant columns — round-trip the data equally faithfully, and neither has a query
advantage, because no endpoint filters, sorts, or joins on `source` (`/plugins/search` matches
`name`/`description`/`category`/`tags` only). The tie is broken by the schema's own comment in
`packages/core/src/marketplace.ts`: *"v1 supports exactly these two source types. Deliberately no
archive, command, or git-subdir sources, and no cross-marketplace dependencies."* The churn risk that
normally makes a JSON column attractive — an open or growing union needing a migration per new
variant — is ruled out by design, by the schema authors, in the schema file itself. With churn off
the table, the discriminant-plus-columns encoding wins on the axis that actually matters here: it
lets SQLite enforce the union's arity as a `CHECK` constraint, so a row with `source_type='github'`
and a NULL `repo`, or a half-mapped row carrying both `package` and `repo`, is rejected **at write
time** rather than surfacing later as a malformed `source` object inside `GET /marketplace.json` —
the one payload `marketplace add` depends on, and whose only other guard (F-002's
`Marketplace.decode`) runs on the manifest *before* it is mapped to columns, not after. An opaque
JSON blob has no equivalent write-time guard. The cost is one pure `toSourceJson`/`sourceColumns`
pair (§2.3), which is also the single place a third source type would ever need touching if XCOD-8's
v1 restriction is lifted.

---

## 2. The D1 DI seam — `packages/registry/src/db.ts`

### 2.1 Derived schema types

```ts
// packages/registry/src/db.ts
import type { D1Database } from "@cloudflare/workers-types"
import type { Marketplace } from "@opencode-ai/core/marketplace"

/**
 * Plain-JSON (encoded) forms of the XCOD-8 schema, DERIVED from
 * packages/core/src/marketplace.ts — never redefined here.
 *
 * `import type` is MANDATORY, not stylistic: the Worker needs these only as types
 * (decoding happens exclusively in F-002's seed script and in unit tests), so a
 * type-only import keeps `effect` out of the Worker bundle entirely.
 */
export type OwnerJson = typeof Marketplace.Owner.Encoded
export type SourceJson = typeof Marketplace.Source.Encoded
export type EntryJson = typeof Marketplace.Entry.Encoded
export type ManifestJson = typeof Marketplace.Manifest.Encoded
```

Verified by compilation against `effect@4.0.0-beta.83` (the catalog version) with
`strict`, `verbatimModuleSyntax`, and `isolatedModules` on. `typeof Marketplace.Entry.Encoded`
resolves to:

```ts
{
  readonly name: string
  readonly source:
    | { readonly type: "npm";    readonly package: string; readonly version?: string | undefined }
    | { readonly type: "github"; readonly repo: string;    readonly ref?:     string | undefined }
  readonly description?: string | undefined
  readonly version?:     string | undefined
  readonly author?:      string | undefined
  readonly category?:    string | undefined
  readonly tags?:        readonly string[] | undefined
}
```

### 2.2 Record types

```ts
/** One ingested marketplace — one `marketplace` row, shaped for GET /marketplaces. */
export interface MarketplaceRecord {
  readonly name: string
  readonly owner: OwnerJson
  readonly description?: string
  readonly version?: string
  /** Derived aggregate (COUNT over `plugin`), not a stored column. */
  readonly pluginCount: number
  /** Registry-native: where the registry resolved this marketplace from. */
  readonly source: string
}

/**
 * One `plugin` row: every Marketplace.Entry field, plus the denormalized parent
 * marketplace name. NOTE the intersection form — `interface … extends EntryJson`
 * is not valid against a derived object type.
 */
export type PluginRecord = EntryJson & { readonly marketplace: string }
```

`PluginRecord` deliberately carries **all** Entry fields (including `author` and `version`) because
`GET /marketplace.json` needs them. Individual handlers project down — see §4.4.

### 2.3 NULL handling and source mapping (the two mandatory pure helpers)

```ts
/**
 * D1 returns SQL NULL as `null`, but every optional field in the XCOD-8 schema is
 * `T | undefined` and REJECTS `null` (compile-enforced: `Type 'null' is not assignable
 * to type 'string | undefined'`). Map every nullable column through this.
 *
 * Never emit `null` in a response body. `JSON.stringify` (and therefore `Response.json`)
 * drops `undefined`-valued keys but preserves `null`, so an unmapped column would put a
 * literal `null` on the wire and break the client's `Marketplace.decode`.
 */
export const optional = <T>(value: T | null | undefined): T | undefined => value ?? undefined

export interface SourceColumns {
  readonly source_type: string
  readonly source_package: string | null
  readonly source_version: string | null
  readonly source_repo: string | null
  readonly source_ref: string | null
}

/** `plugin` row columns -> Marketplace.Source. Inverse of `sourceColumns`. */
export function toSourceJson(row: SourceColumns): SourceJson {
  switch (row.source_type) {
    case "npm":
      // Guaranteed non-null by the CHECK constraint; guarded so a corrupt row becomes a
      // 500 rather than a malformed manifest served to `marketplace add`.
      if (row.source_package === null) throw new Error("plugin row: source_type='npm' with NULL source_package")
      return { type: "npm", package: row.source_package, version: optional(row.source_version) }
    case "github":
      if (row.source_repo === null) throw new Error("plugin row: source_type='github' with NULL source_repo")
      return { type: "github", repo: row.source_repo, ref: optional(row.source_ref) }
    default:
      throw new Error(`plugin row: unknown source_type '${row.source_type}'`)
  }
}

/** Marketplace.Source -> `plugin` row columns. Inverse of `toSourceJson`. */
export function sourceColumns(source: SourceJson): SourceColumns {
  return source.type === "npm"
    ? {
        source_type: "npm",
        source_package: source.package,
        source_version: source.version ?? null,
        source_repo: null,
        source_ref: null,
      }
    : {
        source_type: "github",
        source_package: null,
        source_version: null,
        source_repo: source.repo,
        source_ref: source.ref ?? null,
      }
}
```

`tags` follows the same discipline: read as
`row.tags === null ? undefined : (JSON.parse(row.tags) as string[])`, written as
`entry.tags ? JSON.stringify(entry.tags) : null`.

### 2.4 The seam itself

```ts
/** Read side. C-001, C-002 and C-003 code against ONLY this. */
export interface RegistryReadDb {
  /** Every marketplace row, `pluginCount` aggregated, ordered by name. */
  listMarketplaces(): Promise<MarketplaceRecord[]>

  /**
   * Every plugin row across every marketplace, flattened with its parent marketplace
   * name, ordered by (marketplace, name). `filter` is applied in-memory by the
   * implementation, so pushing the predicate into SQL later stays behind this seam.
   */
  listPlugins(options?: { readonly filter?: (plugin: PluginRecord) => boolean }): Promise<PluginRecord[]>
}

/** Write side. ONLY F-002's seed script codes against this. */
export interface RegistryWriteDb {
  /**
   * Atomically replace one marketplace and all of its plugins. Applies
   * `buildReplaceStatements` as a single transaction — all rows or none, never
   * a partial write (F-002's AC).
   */
  replaceMarketplace(input: { readonly manifest: ManifestJson; readonly source: string }): Promise<void>
}

export type RegistryDb = RegistryReadDb & RegistryWriteDb

/** One parameterised SQL statement. */
export interface Statement {
  readonly sql: string
  readonly params: readonly unknown[]
}

/**
 * PURE. The ordered statement list `replaceMarketplace` executes, with no I/O of any
 * kind. This is what makes F-002's "invalid manifest => zero writes" test trivial: the
 * test asserts the statement list is never built / never handed to a transport, with no
 * D1 and no fake SQL engine involved.
 *
 * Order is load-bearing and satisfies the FK constraint without any PRAGMA:
 *   1. DELETE FROM plugin      WHERE marketplace_name = ?   (children first)
 *   2. DELETE FROM marketplace WHERE name = ?               (then parent)
 *   3. INSERT INTO marketplace (...) VALUES (...)           (parent before children)
 *   4. INSERT INTO plugin      (...) VALUES (...)           x manifest.plugins.length
 *
 * Steps 1–2 make the seed re-runnable (an idempotent replace scoped to one marketplace),
 * which is also exactly what XCOD-35's refresh job will need.
 */
export declare function buildReplaceStatements(input: {
  readonly manifest: ManifestJson
  readonly source: string
}): readonly Statement[]

/**
 * The ONLY place SQL touches a D1 binding. Read-only by construction: it returns
 * `RegistryReadDb`, so the Worker cannot write even by mistake. Body is C-001's to
 * write against the §1.4 queries and the §2.3 mappers.
 */
export declare function d1ReadDb(db: D1Database): RegistryReadDb
```

> The two `declare`d functions above are **signatures only** — this contract fixes their shapes,
> not their bodies. `buildReplaceStatements` is F-002's to implement (against §1.2's columns and
> §2.3's `sourceColumns`); `d1ReadDb` is C-001's (against §1.4's queries and §2.3's mappers). Drop
> the `declare` keyword when writing the real implementation.

**Seed write transport is F-002's to select and document.** The Worker-side implementation of an
atomic statement list is `db.batch(...)`, but F-002's seed is a Bun script with no binding. Two
candidates, both consuming the same `buildReplaceStatements` output:

1. **Cloudflare D1 HTTP query API** (`POST …/d1/database/{uuid}/query` with `{ sql, params }`) —
   **recommended**: it preserves parameter binding, so 36 free-text descriptions never pass through
   hand-rolled SQL quoting, and its wire shape is already `{ sql, params }`. Needs account ID, API
   token and the database UUID.
2. **`wrangler d1 execute <db> --remote --file=…`** over a generated `.sql` file — simpler
   credentials story, but has **no parameter binding**, so every string literal must be escaped by
   hand. Flagged as the riskier option, not forbidden.

### 2.5 Shared search predicate

```ts
/**
 * Mirrors `searchPlugins` (packages/opencode/src/plugin/discover.ts) exactly, so a query
 * behaves identically whether the client filters its cache or the registry filters
 * server-side. Haystack is name / description / category / tags — explicitly NOT `author`,
 * explicitly NOT `marketplace`.
 *
 * `q` present-but-empty yields needle `""`, and `includes("")` is always true => all
 * plugins, matching the client byte-for-byte (GAP-001).
 */
export function matchesQuery(query: string): (plugin: PluginRecord) => boolean {
  const needle = query.trim().toLowerCase()
  return (plugin) => {
    const haystack = [plugin.name, plugin.description ?? "", plugin.category ?? "", ...(plugin.tags ?? [])]
    return haystack.some((value) => value.toLowerCase().includes(needle))
  }
}
```

### 2.6 Fixed constants

```ts
// GAP-002, resolved in the stories doc. Literal constants — NEVER derived from, or
// compared against, any seeded marketplace row's own name/owner.
export const REGISTRY_MANIFEST_NAME = "lunos-registry"
export const REGISTRY_MANIFEST_OWNER: OwnerJson = { name: "Lunos", url: "https://github.com/pminev1/Lunos" }

// The `source` value F-002's seed writes for the repo-root marketplace.json. Fixed HERE
// (the seed reads a local file, so there is no URL to observe); the value chosen is the
// repo the seed manifest lives in, matching XCOD-33's own /marketplaces example.
// INDEPENDENT of REGISTRY_MANIFEST_OWNER.url and of the seed manifest's own `owner.url`
// (both verified as this same string today). Three separate concepts that happen to share
// a value — do not collapse them into one constant or derive one from another.
export const SEED_SOURCE = "https://github.com/pminev1/Lunos"
```

---

## 3. The `Env` type — `packages/registry/src/index.ts`

```ts
import type { D1Database } from "@cloudflare/workers-types"

/**
 * Declared locally in the handler file, per this repo's Worker convention
 * (cf. `type Env = { AuthStorage: KVNamespace }` in packages/console/function/src/auth.ts).
 * NOT from sst-env.d.ts — that file only covers SST `Resource`-proxy values, not raw
 * Cloudflare bindings.
 *
 * The key MUST match the SST logical name in infra/registry.ts exactly:
 *   new sst.cloudflare.D1("MarketplaceRegistryDb", { transform: { database: { jurisdiction: "eu" } } })
 *   -> link: [registryDb] -> env.MarketplaceRegistryDb
 */
type Env = {
  MarketplaceRegistryDb: D1Database
}
```

Not exported — one local declaration per Worker entry file, matching `auth.ts`.

**Status: by analogy, not confirmed.** `auth.ts` proves SST surfaces a linked
`sst.cloudflare.Kv("AuthStorage")` as `env.AuthStorage`; this repo has no D1 precedent, so the D1
equivalent is inference. F-001's AC ("the D1 binding resolves at runtime without error") is the
check that promotes this to confirmed — do not treat it as settled before then.

`@cloudflare/workers-types` is already in the root catalog at `4.20251008.0`; add it as a
`devDependency: "catalog:"` on `packages/registry`, and list it in `tsconfig.json`'s `types` array
exactly as `packages/console/function/tsconfig.json` does.

---

## 4. Error envelope and router-level responses

### 4.1 The envelope — CONFIRMED as `{ "error": string }`, no error code field

GAP-003's working default stands. No `code` field is added, because the API has no programmatic
error consumer: the only real client is the Lunos CLI's `fetchText`
(`packages/opencode/src/marketplace/shared.ts`), which discards the response body entirely and
throws `Request to ${url} failed with status ${response.status}`. Every other consumer today is a
human with curl. An error-code taxonomy would be speculative generality for a v1 with nothing to
branch on it. Revisit only when a registry-aware client actually needs to distinguish error kinds
(XCOD-35 or later).

### 4.2 `packages/registry/src/response.ts`

```ts
/**
 * The ONLY error body shape in this API (GAP-003). `message` is always a fixed,
 * caller-safe string — never a raw exception or D1 error message, which can leak SQL
 * and schema details.
 */
export function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, headers })
}

export const badRequest = (message: string) => errorResponse(400, message)
export const notFound = () => errorResponse(404, "Not Found")
export const methodNotAllowed = () => errorResponse(405, "Method Not Allowed", { Allow: "GET" })
export const internalError = () => errorResponse(500, "Internal Server Error")
```

### 4.3 Router (C-001) — literal construction for the 404 / 405 / 500 cases

```ts
export type Handler = (ctx: { readonly url: URL; readonly db: RegistryReadDb }) => Promise<Response>

const routes: Record<string, Handler> = {
  "/marketplaces": handleMarketplaces,      // C-002
  "/plugins": handlePlugins,                // C-002
  "/plugins/search": handlePluginsSearch,   // C-003
  "/marketplace.json": handleMarketplaceJson, // C-001
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Order is load-bearing (GAP-004): match the PATH first, then the method, so
    //   POST /marketplaces -> 405 (known path, wrong method)
    //   POST /nope         -> 404 (genuinely unmatched path)
    // Exact pathname equality only — no trailing-slash normalisation, so `/plugins/`
    // is a 404. Deliberate: KISS, and no client produces it.
    const handler = routes[url.pathname]
    if (!handler) return notFound()
    if (request.method !== "GET") return methodNotAllowed()

    try {
      return await handler({ url, db: d1ReadDb(env.MarketplaceRegistryDb) })
    } catch (error) {
      // Logged, never returned: the client gets a fixed string, not the D1 error.
      console.error("registry request failed", url.pathname, error)
      return internalError()
    }
  },
}
```

One router-level `try`/`catch` covers every endpoint's "D1 query failure / binding unavailable → 5xx
with `{ "error": string }`" AC (C-001, C-002, C-003). **Handlers must not catch D1 errors
themselves** — let them propagate so the 5xx body stays uniform.

C-003's absent-`q` case is the one 4xx a handler raises itself:

```ts
if (!url.searchParams.has("q")) return badRequest("Missing required query parameter: q")
```

**Deviation to note at review:** `stat.ts`'s precedent returns a plain-text body
(`new Response("Method Not Allowed", { status: 405 })`). This contract keeps that *status code* but
uses the JSON envelope for the body, so every response from this Worker — success and failure — is
`application/json`. The `Allow: GET` header is added per RFC 9110's requirement on 405. No
`Cache-Control` in v1.

### 4.4 Response projections (shape-compliance trap)

| Endpoint | Fields emitted | Source |
|---|---|---|
| `GET /marketplaces` | `name`, `owner`, `description?`, `version?`, `pluginCount`, `source` | `MarketplaceRecord` |
| `GET /plugins` | `name`, `marketplace`, `description?`, `category?`, `tags?`, `source` | `PluginRecord`, projected |
| `GET /plugins/search` | identical to `GET /plugins` | `PluginRecord`, filtered then projected |
| `GET /marketplace.json` | `name`, `owner`, `plugins: EntryJson[]` | constants §2.6 + `PluginRecord` minus `marketplace` |

**`GET /plugins` and `GET /plugins/search` omit `author` and `version`.** This is deliberate, not an
example oversight: C-002's AC lists exactly six fields, and the client's own `PluginListEntry`
(`packages/opencode/src/plugin/discover.ts`) carries exactly `name`, `marketplace`, `description`,
`category`, `tags` and `spec` — no `author`, no `version`. The registry response is that same row
with raw `source` in place of `spec`. `PluginRecord` still carries both fields because
`/marketplace.json`'s `Entry` objects need them.

**`GET /marketplaces` emits `version` when the marketplace has one.** The sources disagree and this
contract resolves it: XCOD-33's normative prose says each entry is *"the manifest's top-level fields
(`name`, `owner`, `description`, `version`) plus `pluginCount` … and `source`"* — **that sentence
governs**. XCOD-33's example response and C-002's AC field list both omit `version` because they
depict a manifest that has none; since `version` is `Schema.optional`, the key is simply absent for
such a marketplace, which makes all three readings consistent. The real seed does carry
`version: "1.0.0"`, so it will appear in practice. The alternative — selecting and storing the
column but never emitting it — is the one option that satisfies nothing.

**`GET /marketplace.json` omits top-level `description` and `version`.** C-001's AC names them when
describing the `Manifest` shape, but both are `Schema.optional` in XCOD-8, so omitting them still
yields a bare, decode-valid `Manifest`. They are omitted rather than filled because GAP-002 resolved
only `name` and `owner`, and inventing a registry description/version string would reproduce exactly
the failure mode GAP-002 warned about — a synthetic placeholder that a later phase copies as if it
were confirmed. `$schema` is omitted for the same reason. Nothing client-side reads
`manifest.description` or `manifest.version` (verified: zero references across `packages/opencode`).

---

## 5. Gotchas every implementing story must respect

| # | Gotcha |
|---|---|
| 1 | **The seed file has 36 plugins, not 32.** Discovery, journeys and stories all say 32 — that count has drifted. F-002's and V-001's assertions must read `plugins.length` from the file at run time, never hardcode a number. |
| 2 | **Never emit `null`.** SQL NULL → `undefined` via `optional()` (§2.3). The XCOD-8 optional fields reject `null` at the type level, and `Response.json` preserves `null` while dropping `undefined`. |
| 3 | **`import type` only** for `@opencode-ai/core/marketplace` inside `src/index.ts` and `src/handlers/**`. A value import drags `effect` into the Worker bundle for no runtime benefit. `effect` stays a real dependency of `packages/registry` for F-002's seed script and C-001's unit test (both run under Bun), so F-001's bundle sanity check still applies to the seed path. |
| 4 | **`SEED_SOURCE`, `REGISTRY_MANIFEST_OWNER.url` and the seed manifest's `owner.url` are three independent values** that happen to be the same string today. Do not derive one from another. |
| 5 | **`/plugins` omits `author`/`version`; `PluginRecord` keeps them.** See §4.4. |
| 6 | **`Entry.version` ≠ `NpmSource.version`.** Two distinct optional fields, two distinct columns (`version`, `source_version`). Easy to conflate in the row mapper. |
| 7 | **The `Env` binding name is unconfirmed until F-001 runs.** Treat `MarketplaceRegistryDb` as an analogy to `AuthStorage`, not a verified fact. |
| 8 | **Handlers must not catch D1 errors.** The uniform 5xx comes from the single router-level `try`/`catch`. |
| 9 | **Test fixtures need synthetic data.** The real seed is 100% `source.type: "github"` with zero `category`, `tags`, `author` or `version` values (verified). C-002/C-003's `npm`/`category`/`tags` branches cannot be exercised by the real file. |

---

## 6. What was verified for this document

- `packages/core/src/marketplace.ts` read directly; `effect` catalog version is `4.0.0-beta.83`.
- `typeof Marketplace.X.Encoded` **compiles** for `Owner`/`Source`/`Entry`/`Manifest`, including via
  a type-only import of the `export * as Marketplace` namespace re-export, under `strict` +
  `verbatimModuleSyntax` + `isolatedModules`. Resolved shapes reproduced in §2.1.
- `null` is **not** assignable to any derived optional field (compiler-confirmed) — §2.3's mapper is
  mandatory, not defensive.
- `PluginRecord` must use the intersection form; `interface … extends EntryJson` is not valid here.
- Root `marketplace.json`: 36 plugins, `name: "lunos-community"`,
  `owner: { name: "Lunos", url: "https://github.com/pminev1/Lunos" }`, all sources `github`, zero
  `category`/`tags`/`author`/`version` values.
- `packages/console/function/{src/auth.ts,src/stat.ts,tsconfig.json,package.json}` read for the
  `Env`, 405 and Worker-package conventions cited above.
- Zero references to `manifest.description` / `manifest.version` anywhere in `packages/opencode`.
- No `wrangler` dependency and no D1/`d1_databases` reference exists anywhere in this repo today —
  hence §1.1's refusal to pin a CLI invocation that has never been run here.
