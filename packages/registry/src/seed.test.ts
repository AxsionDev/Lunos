import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { buildReplaceStatements, SEED_SOURCE, type ManifestJson, type RegistryWriteDb } from "./db"
import { runSeed, SEED_MANIFEST_PATH } from "./seed"

/**
 * DI seam stand-in for the real D1 write transport, per Discovery's testing convention
 * (a `dep` param defaulting to a real implementation, a fake in tests — same shape as
 * `FetchDeps` in packages/opencode/src/marketplace/shared.ts). Records every call so a
 * test can assert not just what was written but that NOTHING was.
 */
function fakeWriteDb() {
  const calls: { readonly manifest: ManifestJson; readonly source: string }[] = []
  const db: RegistryWriteDb = {
    async replaceMarketplace(input) {
      calls.push(input)
    },
  }
  return { calls, db }
}

/**
 * Synthetic fixture. The real seed file is 100% `source.type: "github"` with zero
 * `category`, `tags`, `author` or `version` values (contracts gotcha #9), so the npm
 * branch and the scalar optionals can only be exercised by hand-built data.
 *
 * Note `version: "9.9.9"` (Entry.version) vs. `source.version: "1.2.3"` (NpmSource.version):
 * two DISTINCT fields mapping to two DISTINCT columns (gotcha #6), given deliberately
 * different values so a mapper that conflates them fails loudly.
 */
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
  ],
}

/** Column order of INSERT_PLUGIN's parameter list, per the DDL in migrations/0001_init.sql. */
const PLUGIN_PARAM = {
  marketplace_name: 0,
  name: 1,
  source_type: 2,
  source_package: 3,
  source_version: 4,
  source_repo: 5,
  source_ref: 6,
  description: 7,
  version: 8,
  author: 9,
  category: 10,
  tags: 11,
} as const

describe("runSeed — decode-before-write gate", () => {
  test("aborts and writes nothing when the manifest is missing a required field", async () => {
    const { calls, db } = fakeWriteDb()
    // Structurally valid JSON, schema-invalid: no top-level `name`.
    const invalid = {
      owner: { name: "Lunos" },
      plugins: [{ name: "p", source: { type: "github", repo: "o/r" } }],
    }

    await expect(runSeed(invalid, db)).rejects.toThrow(/name/)
    expect(calls).toHaveLength(0)
  })

  test("aborts and writes nothing when a plugin's source is malformed", async () => {
    const { calls, db } = fakeWriteDb()
    const invalid = {
      name: "broken",
      owner: { name: "Lunos" },
      plugins: [{ name: "p", source: { type: "archive", url: "https://example.com/p.tgz" } }],
    }

    await expect(runSeed(invalid, db)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test("surfaces a decode error that names the offending path", async () => {
    const { db } = fakeWriteDb()
    const invalid = { name: "broken", owner: { name: "Lunos" }, plugins: [{ source: { type: "npm", package: "p" } }] }

    // The message must be actionable, not a bare "decode failed" — this is the only
    // point in the system where schema-invalid seed data is ever caught.
    await expect(runSeed(invalid, db)).rejects.toThrow(/\["plugins"\]\[0\]/)
  })

  test("writes exactly once on a valid manifest", async () => {
    const { calls, db } = fakeWriteDb()

    await runSeed(npmFixture, db)

    expect(calls).toHaveLength(1)
    expect(calls[0].source).toBe(SEED_SOURCE)
    expect(calls[0].manifest.name).toBe("synthetic-marketplace")
  })
})

describe("buildReplaceStatements", () => {
  test("emits the documented statement order", () => {
    const statements = buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE })

    // Order is load-bearing: children deleted before parent, parent inserted before
    // children — this is what satisfies the FK constraint without any PRAGMA.
    expect(statements).toHaveLength(npmFixture.plugins.length + 3)
    expect(statements[0].sql).toStartWith("DELETE FROM plugin")
    expect(statements[0].params).toEqual(["synthetic-marketplace"])
    expect(statements[1].sql).toStartWith("DELETE FROM marketplace")
    expect(statements[1].params).toEqual(["synthetic-marketplace"])
    expect(statements[2].sql).toStartWith("INSERT INTO marketplace")
    for (const statement of statements.slice(3)) {
      expect(statement.sql).toStartWith("INSERT INTO plugin")
    }
  })

  test("maps the marketplace row's columns in order", () => {
    const [, , insert] = buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE })

    expect(insert.params).toEqual([
      "synthetic-marketplace",
      "Synthetic Owner",
      "owner@example.com",
      "https://example.com/owner",
      "Synthetic manifest exercising the npm branch.",
      "2.0.0",
      SEED_SOURCE,
    ])
  })

  test("keeps Entry.version and NpmSource.version in separate columns", () => {
    const statements = buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE })
    const params = statements[3].params

    expect(params[PLUGIN_PARAM.source_type]).toBe("npm")
    expect(params[PLUGIN_PARAM.source_package]).toBe("@synthetic/plugin")
    // NpmSource.version
    expect(params[PLUGIN_PARAM.source_version]).toBe("1.2.3")
    // Entry.version — a DIFFERENT field, a DIFFERENT column (gotcha #6).
    expect(params[PLUGIN_PARAM.version]).toBe("9.9.9")
    expect(params[PLUGIN_PARAM.source_repo]).toBeNull()
    expect(params[PLUGIN_PARAM.source_ref]).toBeNull()
  })

  test("serializes category, tags and author", () => {
    const statements = buildReplaceStatements({ manifest: npmFixture, source: SEED_SOURCE })
    const params = statements[3].params

    expect(params[PLUGIN_PARAM.author]).toBe("Synthetic Author")
    expect(params[PLUGIN_PARAM.category]).toBe("formatting")
    expect(params[PLUGIN_PARAM.tags]).toBe(JSON.stringify(["formatting", "linting"]))
  })

  test("writes NULL tags when the key is absent but '[]' when it is empty", () => {
    // NULL means "key absent"; '[]' is a distinct, legal value that round-trips as an
    // empty array. Collapsing the two would lose information.
    const absent: ManifestJson = {
      name: "m",
      owner: { name: "o" },
      plugins: [
        { name: "no-tags", source: { type: "github", repo: "o/r" } },
        { name: "empty-tags", source: { type: "github", repo: "o/r2" }, tags: [] },
      ],
    }
    const statements = buildReplaceStatements({ manifest: absent, source: SEED_SOURCE })

    expect(statements[3].params[PLUGIN_PARAM.tags]).toBeNull()
    expect(statements[4].params[PLUGIN_PARAM.tags]).toBe("[]")
  })

  test("writes NULL, never undefined, for absent optional columns", () => {
    // D1 binds `undefined` inconsistently; the mappers must normalise to SQL NULL.
    const bare: ManifestJson = {
      name: "m",
      owner: { name: "o" },
      plugins: [{ name: "p", source: { type: "github", repo: "o/r" } }],
    }
    const statements = buildReplaceStatements({ manifest: bare, source: SEED_SOURCE })

    for (const statement of statements) {
      for (const param of statement.params) {
        expect(param).not.toBeUndefined()
      }
    }
    expect(statements[2].params).toEqual(["m", "o", null, null, null, null, SEED_SOURCE])
  })

  test("produces no plugin inserts for a manifest with an empty plugin list", () => {
    const empty: ManifestJson = { name: "m", owner: { name: "o" }, plugins: [] }

    expect(buildReplaceStatements({ manifest: empty, source: SEED_SOURCE })).toHaveLength(3)
  })
})

describe("the real repo-root marketplace.json", () => {
  // Read from disk rather than statically imported — the seed manifest lives at the repo
  // root, outside this package's rootDir, and the counts below must reflect the file as it
  // is TODAY (contracts gotcha #1: the count has already drifted once; never hardcode it).
  const raw: { plugins: unknown[] } = JSON.parse(readFileSync(SEED_MANIFEST_PATH, "utf8"))

  test("decodes successfully", () => {
    const manifest = Marketplace.decode(raw)

    expect(manifest.name).toBe("lunos-community")
    expect(manifest.plugins.length).toBe(raw.plugins.length)
    expect(manifest.plugins.length).toBeGreaterThan(0)
  })

  test("produces exactly 1 marketplace insert and plugins.length plugin inserts", () => {
    const manifest = Marketplace.decode(raw)
    const statements = buildReplaceStatements({ manifest, source: SEED_SOURCE })

    const marketplaceInserts = statements.filter((s) => s.sql.startsWith("INSERT INTO marketplace"))
    const pluginInserts = statements.filter((s) => s.sql.startsWith("INSERT INTO plugin"))

    expect(marketplaceInserts).toHaveLength(1)
    // Read from the file at run time — NOT a hardcoded 32 or 36.
    expect(pluginInserts).toHaveLength(raw.plugins.length)
    expect(statements).toHaveLength(raw.plugins.length + 3)
  })

  test("seeds through the DI seam with SEED_SOURCE", async () => {
    const { calls, db } = fakeWriteDb()

    const { manifest } = await runSeed(raw, db)

    expect(calls).toHaveLength(1)
    expect(calls[0].manifest.name).toBe("lunos-community")
    expect(calls[0].source).toBe(SEED_SOURCE)
    // SEED_SOURCE is INDEPENDENT of the manifest's own owner.url (gotcha #4) — they merely
    // happen to hold the same string today, which is exactly why this asserts the constant
    // rather than reading it off the manifest.
    expect(manifest.plugins.length).toBe(raw.plugins.length)
  })
})
