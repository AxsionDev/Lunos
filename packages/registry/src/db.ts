import type { D1Database } from "@cloudflare/workers-types"
import type { Marketplace } from "@opencode-ai/core/marketplace"

/**
 * Plain-JSON (encoded) forms of the XCOD-8 schema, DERIVED from
 * packages/core/src/marketplace.ts — never redefined here.
 *
 * `import type` is MANDATORY, not stylistic: THIS FILE needs these only as types (decoding
 * happens in F-002's seed script, in resolve.ts's XCOD-35 ingestion resolver, and in unit
 * tests — never here), so a type-only import keeps `effect` out of db.ts specifically. It
 * does NOT keep `effect` out of the Worker bundle as a whole any more: unlike index.ts's
 * fetch handler (still effect-free, see its BUNDLE CONSTRAINT comment), the cron worker
 * (ingest-worker.ts) value-imports `Marketplace` for real schema validation of fetched
 * manifests, so effect legitimately enters THAT bundle.
 */
export type OwnerJson = typeof Marketplace.Owner.Encoded
export type SourceJson = typeof Marketplace.Source.Encoded
export type EntryJson = typeof Marketplace.Entry.Encoded
export type ManifestJson = typeof Marketplace.Manifest.Encoded

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

/**
 * D1 returns SQL NULL as `null`, but every optional field in the XCOD-8 schema is
 * `T | undefined` and REJECTS `null` (compile-enforced: `Type 'null' is not assignable
 * to type 'string | undefined'`). Map every nullable column through this.
 *
 * Never emit `null` in a response body. `JSON.stringify` (and therefore `Response.json`)
 * drops `undefined`-valued keys but preserves `null`, so an unmapped column would put a
 * literal `null` on the wire and break the client's `Marketplace.decode`.
 *
 * `??` and not `||`: an empty string is a legal value and must survive unchanged.
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

/**
 * XCOD-35's read seam. Deliberately NOT a member of `RegistryReadDb` above: C-001/C-002/
 * C-003's handlers never need the source list, so folding it in would force every one of
 * their test fakes to implement a method they never call — a real cost the codebase
 * elsewhere pays close attention to (`RegistryReadDb`'s own docstring scopes it to exactly
 * those three handlers).
 */
export interface IngestionSourceDb {
  /**
   * Every DISTINCT `marketplace.source` value — "every registered source" the ingestion
   * job re-resolves. There is deliberately no separate sources table: a marketplace row's
   * own `source` column already IS the registered-source record (written once by
   * `replaceMarketplace`/the seed, re-written idempotently by every successful ingestion
   * run), so a second table would only duplicate it.
   */
  listMarketplaceSources(): Promise<string[]>
}

/** Write side. F-002's seed script and F-003's (XCOD-35) ingestion job code against this. */
export interface RegistryWriteDb {
  /**
   * Atomically replace one marketplace and all of its plugins. Applies
   * `buildReplaceStatements` as a single transaction — all rows or none, never
   * a partial write (F-002's AC, and XCOD-35's "failure leaves last-known-good data
   * intact" AC: a failed resolve must never reach this method at all).
   */
  replaceMarketplace(input: { readonly manifest: ManifestJson; readonly source: string }): Promise<void>
}

export type RegistryDb = RegistryReadDb & RegistryWriteDb

/** One parameterised SQL statement. */
export interface Statement {
  readonly sql: string
  readonly params: readonly unknown[]
}

const INSERT_MARKETPLACE =
  "INSERT INTO marketplace (name, owner_name, owner_email, owner_url, description, version, source)" +
  " VALUES (?, ?, ?, ?, ?, ?, ?)"

const INSERT_PLUGIN =
  "INSERT INTO plugin (marketplace_name, name, source_type, source_package, source_version," +
  " source_repo, source_ref, description, version, author, category, tags)" +
  " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

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
export function buildReplaceStatements(input: {
  readonly manifest: ManifestJson
  readonly source: string
}): readonly Statement[] {
  const { manifest, source } = input

  const statements: Statement[] = [
    { sql: "DELETE FROM plugin WHERE marketplace_name = ?", params: [manifest.name] },
    { sql: "DELETE FROM marketplace WHERE name = ?", params: [manifest.name] },
    {
      sql: INSERT_MARKETPLACE,
      params: [
        manifest.name,
        manifest.owner.name,
        manifest.owner.email ?? null,
        manifest.owner.url ?? null,
        manifest.description ?? null,
        manifest.version ?? null,
        source,
      ],
    },
  ]

  for (const entry of manifest.plugins) {
    const columns = sourceColumns(entry.source)
    statements.push({
      sql: INSERT_PLUGIN,
      params: [
        manifest.name,
        entry.name,
        columns.source_type,
        columns.source_package,
        columns.source_version,
        columns.source_repo,
        columns.source_ref,
        entry.description ?? null,
        // Entry.version, NOT NpmSource.version (contracts gotcha #6) — the latter is
        // already carried by `columns.source_version` two params above.
        entry.version ?? null,
        entry.author ?? null,
        entry.category ?? null,
        // `[]` is truthy, so an explicitly-empty tag list round-trips as '[]' rather than
        // collapsing to NULL (which means "key absent").
        entry.tags ? JSON.stringify(entry.tags) : null,
      ],
    })
  }

  return statements
}

/**
 * The canonical read queries, fixed by contracts §1.4 so C-001/C-002/C-003 do not each
 * write their own. Exported so `read-queries.test.ts` can execute this EXACT text against
 * the real `migrations/0001_init.sql` schema under `bun:sqlite` — a typo'd column name or
 * a dropped `AS plugin_count` alias is otherwise invisible until a live D1 request.
 * Exporting the text does not widen the seam: `d1ReadDb` below is still the only place
 * any of it is handed to a D1 binding.
 */
export const LIST_MARKETPLACES_SQL =
  "SELECT m.name, m.owner_name, m.owner_email, m.owner_url, m.description, m.version, m.source," +
  " (SELECT COUNT(*) FROM plugin p WHERE p.marketplace_name = m.name) AS plugin_count" +
  " FROM marketplace m" +
  " ORDER BY m.name"

export const LIST_PLUGINS_SQL =
  "SELECT marketplace_name, name," +
  " source_type, source_package, source_version, source_repo, source_ref," +
  " description, version, author, category, tags" +
  " FROM plugin" +
  " ORDER BY marketplace_name, name"

/** XCOD-35: backs `listMarketplaceSources`. `DISTINCT` because two marketplaces can share
 * one source (e.g. one manifest file listing more than one `marketplace` entry, per a
 * multi-marketplace source) — the ingestion job must re-resolve that source once, not once
 * per marketplace row it produced. */
export const LIST_MARKETPLACE_SOURCES_SQL = "SELECT DISTINCT source FROM marketplace ORDER BY source"

/**
 * One row of `LIST_MARKETPLACES_SQL`. A `type` and not an `interface`: D1's `all<T>()` and
 * `bun:sqlite`'s `query<T>()` both constrain `T` to something index-signature-compatible,
 * which an interface does not satisfy implicitly.
 */
export type MarketplaceRow = {
  readonly name: string
  readonly owner_name: string
  readonly owner_email: string | null
  readonly owner_url: string | null
  readonly description: string | null
  readonly version: string | null
  readonly source: string
  /** The correlated-subquery aggregate — derived, never a stored column. */
  readonly plugin_count: number
}

/** One row of `LIST_PLUGINS_SQL`. */
export type PluginRow = SourceColumns & {
  readonly marketplace_name: string
  readonly name: string
  readonly description: string | null
  readonly version: string | null
  readonly author: string | null
  readonly category: string | null
  /** A JSON array of strings, or NULL when the key was absent. */
  readonly tags: string | null
}

/**
 * PURE row -> record mappers. Every nullable column goes through `optional()` so a SQL
 * NULL becomes `undefined` and never reaches the wire as a literal `null` (gotcha #2).
 */
export function toMarketplaceRecord(row: MarketplaceRow): MarketplaceRecord {
  return {
    name: row.name,
    owner: { name: row.owner_name, email: optional(row.owner_email), url: optional(row.owner_url) },
    description: optional(row.description),
    version: optional(row.version),
    pluginCount: row.plugin_count,
    source: row.source,
  }
}

export function toPluginRecord(row: PluginRow): PluginRecord {
  return {
    marketplace: row.marketplace_name,
    name: row.name,
    // `toSourceJson` reassembles the tagged union from the discriminant + variant columns,
    // and throws on a corrupt row so it surfaces as a 500 rather than a malformed manifest.
    source: toSourceJson(row),
    description: optional(row.description),
    // Entry.version, NOT NpmSource.version (gotcha #6) — the latter is already inside
    // `source` above, reassembled from the `source_version` column.
    version: optional(row.version),
    author: optional(row.author),
    category: optional(row.category),
    // NULL means "key absent" -> undefined; '[]' is a distinct, legal value that
    // round-trips as an empty array.
    tags: row.tags === null ? undefined : (JSON.parse(row.tags) as string[]),
  }
}

/**
 * The ONLY place SQL touches a D1 binding. Read-only by construction: it returns
 * `RegistryReadDb`, so the Worker cannot write even by mistake.
 *
 * Construction is deliberately inert — every `prepare`/`all` call lives inside a method, so
 * nothing here can throw outside the router's single `try`/`catch`. An absent or broken
 * binding therefore surfaces as the uniform 500 from the router, not as an unhandled
 * exception in `fetch` (contracts §4.3, gotcha #8).
 */
export function d1ReadDb(db: D1Database): RegistryReadDb {
  return {
    async listMarketplaces() {
      const { results } = await db.prepare(LIST_MARKETPLACES_SQL).all<MarketplaceRow>()
      return results.map(toMarketplaceRecord)
    },

    async listPlugins(options) {
      const { results } = await db.prepare(LIST_PLUGINS_SQL).all<PluginRow>()
      const plugins = results.map(toPluginRecord)
      // Filtered in memory, not in SQL: C-003 must mirror the client's `searchPlugins`
      // semantics exactly (§1.4). Pushing the predicate into SQL later stays behind
      // this seam.
      return options?.filter ? plugins.filter(options.filter) : plugins
    },
  }
}

/** XCOD-35's source-list read transport. Separate from `d1ReadDb` for the same reason
 * `IngestionSourceDb` is separate from `RegistryReadDb` above — see that interface's doc. */
export function d1IngestionSourceDb(db: D1Database): IngestionSourceDb {
  return {
    async listMarketplaceSources() {
      const { results } = await db.prepare(LIST_MARKETPLACE_SOURCES_SQL).all<{ source: string }>()
      return results.map((row) => row.source)
    },
  }
}

/**
 * XCOD-35's write transport: unlike F-002's seed (a Bun CLI process with no D1 binding, so
 * its write had to go over HTTP and was deliberately deferred), the ingestion job runs
 * INSIDE the Worker and has the real binding — the same one `d1ReadDb` above wraps — so
 * this is the natural, already-available write path. It is a separate function, not a
 * write-mode branch on `d1ReadDb`, so `index.ts`'s fetch handler (which only ever
 * constructs `d1ReadDb`) has no code path that can reach it.
 *
 * `db.batch(...)` is D1's documented atomic-transaction primitive: every statement
 * commits or none do. That is what makes `buildReplaceStatements`' "DELETE then INSERT"
 * ordering safe to use here — a batch failure partway through cannot leave a marketplace
 * with its old rows deleted and no new ones written, which is exactly the corruption
 * XCOD-35's "failure doesn't corrupt last-known-good data" AC forbids.
 */
export function d1WriteDb(db: D1Database): RegistryWriteDb {
  return {
    async replaceMarketplace(input) {
      const statements = buildReplaceStatements(input)
      await db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
    },
  }
}

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

// GAP-002, resolved in the stories doc. Literal constants — NEVER derived from, or
// compared against, any seeded marketplace row's own name/owner.
export const REGISTRY_MANIFEST_NAME = "lunos-registry"
export const REGISTRY_MANIFEST_OWNER: OwnerJson = { name: "Lunos", url: "https://github.com/pminev1/Lunos" }

// The `source` value F-002's seed writes for the repo-root marketplace.json. Fixed HERE
// (the seed reads a local file, so there is no URL to observe); the value chosen is the
// repo the seed manifest lives in, matching XCOD-33's own /marketplaces example.
// INDEPENDENT of REGISTRY_MANIFEST_OWNER.url and of the seed manifest's own `owner.url`
// (both verified as this same string today, modulo the bare-shorthand form below).
// Three separate concepts that happen to share a value — do not collapse them into one
// constant or derive one from another.
//
// Bare "owner/repo" GitHub shorthand, NOT the "https://github.com/..." landing-page form
// used for the two `url` fields above: XCOD-35's `resolveSource` (resolve.ts) re-fetches
// this value on a schedule, and only the shorthand form round-trips through GitHub's API
// (repo default-branch lookup -> raw.githubusercontent.com) to real manifest content — the
// landing-page URL fetched literally returns an HTML page, not JSON, and would fail every
// ingestion run.
export const SEED_SOURCE = "pminev1/Lunos"
