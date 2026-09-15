import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import path from "path"
import {
  buildReplaceStatements,
  LIST_MARKETPLACES_SQL,
  LIST_PLUGINS_SQL,
  SEED_SOURCE,
  toMarketplaceRecord,
  toPluginRecord,
  type ManifestJson,
  type MarketplaceRow,
  type PluginRow,
  type Statement,
} from "./db"

/**
 * Executes the CANONICAL READ QUERIES (contracts §1.4) — the exact SQL text `d1ReadDb`
 * hands to the D1 binding — against the real `migrations/0001_init.sql` schema in an
 * in-memory SQLite database, and runs the resulting rows through the real row mappers.
 *
 * SCOPE, precisely: `d1ReadDb` itself cannot be tested without a live D1 binding, so it is
 * kept deliberately mechanical — `prepare(SQL).all<Row>()` plus `.map(mapper)`. Everything
 * on either side of that one untestable line IS covered here: that each SELECT's column
 * list matches the DDL, that `AS plugin_count` produces the aliased column the mapper
 * reads, that `ORDER BY` is deterministic, and that row -> record mapping turns SQL NULL
 * into `undefined` rather than `null`. A typo in any of those is otherwise invisible until
 * a live request.
 *
 * F-002's migrations.test.ts covers the WRITE side (buildReplaceStatements -> DDL) and the
 * `toSourceJson`/`sourceColumns` pair; it does not touch either SELECT. This file is
 * separate rather than a new describe block there so F-002's suite stays byte-unchanged.
 * The five-line `migrated()`/`apply()` harness is duplicated for the same reason.
 *
 * This is NOT a D1 integration test. D1 is SQLite-backed and `bun:sqlite` ships with Bun,
 * so it needs no new dependency and no cloud access.
 */
const MIGRATION_PATH = path.join(import.meta.dir, "../migrations/0001_init.sql")

function migrated(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(readFileSync(MIGRATION_PATH, "utf8"))
  return db
}

function apply(db: Database, statements: readonly Statement[]): void {
  db.transaction(() => {
    for (const statement of statements) {
      db.query(statement.sql).run(...statement.params.map((value) => value as string | null))
    }
  })()
}

/**
 * Two marketplaces, seeded out of alphabetical order so `ORDER BY` is actually exercised
 * rather than coincidentally satisfied by insertion order.
 */
const zulu: ManifestJson = {
  name: "zulu-marketplace",
  owner: { name: "Zulu Owner", email: "zulu@example.com", url: "https://example.com/zulu" },
  description: "Seeded second, sorts last.",
  version: "2.0.0",
  plugins: [
    {
      name: "zulu-npm-plugin",
      source: { type: "npm", package: "@zulu/plugin", version: "1.2.3" },
      description: "An npm-sourced plugin with a category and tags.",
      // Entry.version vs. NpmSource.version — DISTINCT columns, deliberately different
      // values so a mapper that conflates them fails loudly (gotcha #6).
      version: "9.9.9",
      author: "Zulu Author",
      category: "formatting",
      tags: ["formatting", "linting"],
    },
    { name: "alpha-in-zulu", source: { type: "github", repo: "zulu/alpha" }, tags: [] },
  ],
}

/** Every optional absent, and no owner email/url — the shape the real seed file produces. */
const alpha: ManifestJson = {
  name: "alpha-marketplace",
  owner: { name: "Alpha Owner" },
  plugins: [{ name: "bare-plugin", source: { type: "github", repo: "alpha/bare" } }],
}

function seeded(): Database {
  const db = migrated()
  apply(db, buildReplaceStatements({ manifest: zulu, source: SEED_SOURCE }))
  apply(db, buildReplaceStatements({ manifest: alpha, source: "https://example.com/alpha" }))
  return db
}

const readMarketplaces = (db: Database) =>
  db.query<MarketplaceRow, []>(LIST_MARKETPLACES_SQL).all().map(toMarketplaceRecord)

const readPlugins = (db: Database) => db.query<PluginRow, []>(LIST_PLUGINS_SQL).all().map(toPluginRecord)

describe("LIST_MARKETPLACES_SQL", () => {
  test("parses against the real DDL and selects every mapped column", () => {
    // Proof that each name in the SELECT list exists in migrations/0001_init.sql: SQLite
    // rejects an unknown column outright, and the mapper reads each one back BY NAME.
    const db = seeded()

    expect(readMarketplaces(db)).toHaveLength(2)

    db.close()
  })

  test("derives pluginCount from the correlated subquery, per marketplace", () => {
    // `pluginCount` is aggregated, never a stored column (C-002's AC). A dropped
    // `AS plugin_count` alias would surface here as `undefined`, not as a SQL error.
    const db = seeded()

    const [first, second] = readMarketplaces(db)

    expect(first.pluginCount).toBe(alpha.plugins.length)
    expect(second.pluginCount).toBe(zulu.plugins.length)
    expect(Number.isInteger(first.pluginCount)).toBe(true)
  })

  test("orders by name, not by insertion order", () => {
    const db = seeded()

    expect(readMarketplaces(db).map((record) => record.name)).toEqual(["alpha-marketplace", "zulu-marketplace"])

    db.close()
  })

  test("reassembles the flattened owner and carries the registry-native source", () => {
    const db = seeded()

    const zuluRecord = readMarketplaces(db).find((record) => record.name === "zulu-marketplace")!

    expect(zuluRecord.owner).toEqual({ name: "Zulu Owner", email: "zulu@example.com", url: "https://example.com/zulu" })
    expect(zuluRecord.description).toBe("Seeded second, sorts last.")
    expect(zuluRecord.version).toBe("2.0.0")
    expect(zuluRecord.source).toBe(SEED_SOURCE)

    db.close()
  })

  test("maps every NULL column to undefined, never null", () => {
    // gotcha #2: JSON.stringify drops `undefined` keys but preserves `null`, so an unmapped
    // column would put a literal null on the wire.
    const db = seeded()

    const record = readMarketplaces(db).find((r) => r.name === "alpha-marketplace")!

    expect(record.owner.email).toBeUndefined()
    expect(record.owner.url).toBeUndefined()
    expect(record.description).toBeUndefined()
    expect(record.version).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain("null")

    db.close()
  })

  test("returns an empty list against an empty database", () => {
    const db = migrated()

    expect(readMarketplaces(db)).toEqual([])

    db.close()
  })
})

describe("LIST_PLUGINS_SQL", () => {
  test("flattens every plugin across every marketplace", () => {
    const db = seeded()

    expect(readPlugins(db)).toHaveLength(alpha.plugins.length + zulu.plugins.length)

    db.close()
  })

  test("orders by (marketplace, name)", () => {
    const db = seeded()

    expect(readPlugins(db).map((record) => `${record.marketplace}/${record.name}`)).toEqual([
      "alpha-marketplace/bare-plugin",
      "zulu-marketplace/alpha-in-zulu",
      "zulu-marketplace/zulu-npm-plugin",
    ])

    db.close()
  })

  test("round-trips a full npm entry, keeping Entry.version out of the source", () => {
    const db = seeded()

    const record = readPlugins(db).find((r) => r.name === "zulu-npm-plugin")!

    expect(record).toEqual({
      marketplace: "zulu-marketplace",
      name: "zulu-npm-plugin",
      source: { type: "npm", package: "@zulu/plugin", version: "1.2.3" },
      description: "An npm-sourced plugin with a category and tags.",
      version: "9.9.9",
      author: "Zulu Author",
      category: "formatting",
      tags: ["formatting", "linting"],
    })

    db.close()
  })

  test("distinguishes absent tags (NULL) from an explicitly empty list ('[]')", () => {
    const db = seeded()
    const records = readPlugins(db)

    expect(records.find((r) => r.name === "alpha-in-zulu")!.tags).toEqual([])
    expect(records.find((r) => r.name === "bare-plugin")!.tags).toBeUndefined()

    db.close()
  })

  test("maps every NULL column to undefined, never null", () => {
    const db = seeded()

    const record = readPlugins(db).find((r) => r.name === "bare-plugin")!

    expect(record).toEqual({
      marketplace: "alpha-marketplace",
      name: "bare-plugin",
      source: { type: "github", repo: "alpha/bare", ref: undefined },
      description: undefined,
      version: undefined,
      author: undefined,
      category: undefined,
      tags: undefined,
    })
    expect(JSON.stringify(record)).not.toContain("null")

    db.close()
  })

  test("returns an empty list against an empty database", () => {
    const db = migrated()

    expect(readPlugins(db)).toEqual([])

    db.close()
  })

  test("surfaces a corrupt row as a throw, which the router turns into a 500", () => {
    // The CHECK constraint makes this unreachable through the seed path; the guard exists
    // so a row that somehow bypassed it becomes a 500 rather than a malformed manifest
    // served to `marketplace add`.
    const db = migrated()
    apply(db, buildReplaceStatements({ manifest: alpha, source: "https://example.com/alpha" }))
    // Bypasses the CHECK by writing a legal row first, then corrupting it in place.
    db.exec("PRAGMA ignore_check_constraints = ON")
    db.query("UPDATE plugin SET source_repo = NULL WHERE name = 'bare-plugin'").run()

    expect(() => readPlugins(db)).toThrow(/source_repo/)

    db.close()
  })
})
