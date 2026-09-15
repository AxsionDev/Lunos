import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import path from "path"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { buildReplaceStatements, optional, SEED_SOURCE, toSourceJson, type ManifestJson, type Statement } from "./db"
import { SEED_MANIFEST_PATH } from "./seed"

/**
 * Executes `migrations/0001_init.sql` against an in-memory SQLite database and runs the
 * real `buildReplaceStatements` output through it.
 *
 * SCOPE, precisely: D1 is SQLite-backed, and `bun:sqlite` ships with Bun, so this proves —
 * with no new dependency and no cloud access — that the DDL actually PARSES, that the CHECK
 * constraints accept what the mappers produce and reject what they must, and that the
 * INSERT column lists line up with the parameter arrays positionally. That last one is
 * otherwise unguarded: a transposed column in `INSERT_PLUGIN` would pass every pure-function
 * test in seed.test.ts and only surface as corrupt data after a real seed run.
 *
 * This is NOT a D1 integration test. `PRAGMA foreign_keys` is enabled here (D1 omits it —
 * see migrations/README.md) specifically so the FK-satisfying statement ORDER is exercised
 * rather than silently ignored.
 */
const MIGRATION_PATH = path.join(import.meta.dir, "../migrations/0001_init.sql")

interface PluginRow {
  marketplace_name: string
  name: string
  source_type: string
  source_package: string | null
  source_version: string | null
  source_repo: string | null
  source_ref: string | null
  description: string | null
  version: string | null
  author: string | null
  category: string | null
  tags: string | null
}

interface MarketplaceRow {
  name: string
  owner_name: string
  owner_email: string | null
  owner_url: string | null
  description: string | null
  version: string | null
  source: string
}

function migrated(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(readFileSync(MIGRATION_PATH, "utf8"))
  return db
}

/**
 * Narrows a `Statement` parameter to what SQLite can bind. Every column in this schema is
 * TEXT, so string-or-NULL is the complete legal set — anything else (notably `undefined`,
 * which D1 binds inconsistently) is a mapper bug and fails loudly here rather than being
 * silently coerced.
 */
function bind(value: unknown): string | null {
  if (value === null || typeof value === "string") return value
  throw new Error(`unexpected bind parameter of type '${typeof value}': ${JSON.stringify(value)}`)
}

/** Applies the statement list the way the real transport must: one all-or-nothing transaction. */
function apply(db: Database, statements: readonly Statement[]): void {
  db.transaction(() => {
    for (const statement of statements) {
      db.query(statement.sql).run(...statement.params.map(bind))
    }
  })()
}

const npmFixture: ManifestJson = {
  name: "synthetic-marketplace",
  owner: { name: "Synthetic Owner", email: "owner@example.com", url: "https://example.com/owner" },
  description: "Synthetic manifest exercising the npm branch.",
  version: "2.0.0",
  plugins: [
    {
      name: "synthetic-npm-plugin",
      source: { type: "npm", package: "@synthetic/plugin", version: "1.2.3" },
      description: "An npm-sourced plugin with a category and tags.",
      version: "9.9.9",
      author: "Synthetic Author",
      category: "formatting",
      tags: ["formatting", "linting"],
    },
    {
      name: "synthetic-github-plugin",
      source: { type: "github", repo: "synthetic/plugin", ref: "main" },
    },
  ],
}

describe("0001_init.sql", () => {
  test("executes and creates both tables", () => {
    const db = migrated()

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)

    expect(tables).toEqual(["marketplace", "plugin"])
    db.close()
  })

  test("is re-runnable (CREATE TABLE IF NOT EXISTS)", () => {
    const db = migrated()
    expect(() => db.exec(readFileSync(MIGRATION_PATH, "utf8"))).not.toThrow()
    db.close()
  })
})

describe("buildReplaceStatements against the real schema", () => {
  test("inserts the synthetic manifest and reads every column back unchanged", () => {
    const db = migrated()
    apply(db, buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE }))

    const marketplace = db.query<MarketplaceRow, []>("SELECT * FROM marketplace").all()
    expect(marketplace).toEqual([
      {
        name: "synthetic-marketplace",
        owner_name: "Synthetic Owner",
        owner_email: "owner@example.com",
        owner_url: "https://example.com/owner",
        description: "Synthetic manifest exercising the npm branch.",
        version: "2.0.0",
        source: SEED_SOURCE,
      },
    ])

    // Positional proof that INSERT_PLUGIN's column list matches its parameter array: every
    // value below was written by ordinal and is read back by NAME.
    const npm = db.query<PluginRow, [string]>("SELECT * FROM plugin WHERE name = ?").all("synthetic-npm-plugin")[0]

    expect(npm.marketplace_name).toBe("synthetic-marketplace")
    expect(npm.source_type).toBe("npm")
    expect(npm.source_package).toBe("@synthetic/plugin")
    expect(npm.source_version).toBe("1.2.3") // NpmSource.version
    expect(npm.version).toBe("9.9.9") // Entry.version — a DIFFERENT column (gotcha #6)
    expect(npm.description).toBe("An npm-sourced plugin with a category and tags.")
    expect(npm.author).toBe("Synthetic Author")
    expect(npm.category).toBe("formatting")
    expect(npm.tags).toBe(JSON.stringify(["formatting", "linting"]))
    expect(npm.source_repo).toBeNull()
    expect(npm.source_ref).toBeNull()

    db.close()
  })

  test("round-trips every source through the column mappers", () => {
    const db = migrated()
    apply(db, buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE }))

    const rows = db.query<PluginRow, []>("SELECT * FROM plugin ORDER BY marketplace_name, name").all()
    const byName = new Map(rows.map((row) => [row.name, row]))

    for (const entry of npmFixture.plugins) {
      const row = byName.get(entry.name)!
      // toSourceJson(sourceColumns(x)) === x, but with a real SQLite round-trip in between.
      expect(toSourceJson(row)).toEqual(entry.source)
      expect(optional(row.description)).toEqual(entry.description)
      expect(optional(row.version)).toEqual(entry.version)
    }

    db.close()
  })

  test("seeds the real repo-root marketplace.json", () => {
    const db = migrated()
    const raw: { plugins: unknown[] } = JSON.parse(readFileSync(SEED_MANIFEST_PATH, "utf8"))
    const manifest = Marketplace.decode(raw)

    apply(db, buildReplaceStatements({ manifest, source: SEED_SOURCE }))

    const marketplaces = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM marketplace").get()!
    const plugins = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plugin").get()!

    expect(marketplaces.n).toBe(1)
    // Read from the file at run time — NOT a hardcoded 32 or 36 (gotcha #1).
    expect(plugins.n).toBe(raw.plugins.length)

    db.close()
  })

  test("is idempotent — re-seeding replaces rather than duplicating or failing", () => {
    const db = migrated()
    const statements = buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE })

    apply(db, statements)
    // The leading DELETEs make this safe; without them the marketplace PK would collide.
    // Statement ORDER is what satisfies the FK here, with foreign_keys ON and no PRAGMA
    // available on D1.
    expect(() => apply(db, statements)).not.toThrow()

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM marketplace").get()!.n).toBe(1)
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plugin").get()!.n).toBe(npmFixture.plugins.length)

    db.close()
  })
})

describe("CHECK constraints reject malformed source rows", () => {
  function insertPlugin(db: Database, columns: Partial<PluginRow> & { source_type: string }) {
    db.query(
      "INSERT INTO plugin (marketplace_name, name, source_type, source_package, source_version," +
        " source_repo, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "synthetic-marketplace",
      columns.name ?? "bad-plugin",
      columns.source_type,
      columns.source_package ?? null,
      columns.source_version ?? null,
      columns.source_repo ?? null,
      columns.source_ref ?? null,
    )
  }

  function seeded(): Database {
    const db = migrated()
    apply(db, buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE }))
    return db
  }

  test("rejects source_type = 'github' with a NULL repo", () => {
    const db = seeded()
    expect(() => insertPlugin(db, { source_type: "github" })).toThrow()
    db.close()
  })

  test("rejects source_type = 'npm' with a NULL package", () => {
    const db = seeded()
    expect(() => insertPlugin(db, { source_type: "npm" })).toThrow()
    db.close()
  })

  test("rejects a half-mapped row carrying BOTH package and repo", () => {
    // This is the write-time guard an opaque JSON `source` column could not provide.
    const db = seeded()
    expect(() => insertPlugin(db, { source_type: "npm", source_package: "p", source_repo: "o/r" })).toThrow()
    db.close()
  })

  test("rejects an unknown source_type", () => {
    const db = seeded()
    expect(() => insertPlugin(db, { source_type: "archive", source_package: "p" })).toThrow()
    db.close()
  })

  test("rejects a plugin row with no parent marketplace (FK)", () => {
    const db = migrated()
    expect(() => insertPlugin(db, { source_type: "github", source_repo: "o/r" })).toThrow()
    db.close()
  })
})
