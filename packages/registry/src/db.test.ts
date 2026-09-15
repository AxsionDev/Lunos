import { describe, expect, test } from "bun:test"
import {
  matchesQuery,
  optional,
  sourceColumns,
  toSourceJson,
  type PluginRecord,
  type SourceColumns,
  type SourceJson,
} from "./db"

/** A `plugin` row as D1 returns it: every unset optional column is SQL NULL. */
const nullColumns: SourceColumns = {
  source_type: "github",
  source_package: null,
  source_version: null,
  source_repo: null,
  source_ref: null,
}

function plugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    marketplace: "lunos-community",
    name: "example-plugin",
    source: { type: "github", repo: "lunos-community/example" },
    ...overrides,
  }
}

describe("optional", () => {
  test("maps SQL NULL to undefined", () => {
    expect(optional(null)).toBeUndefined()
  })

  test("maps undefined to undefined", () => {
    expect(optional(undefined)).toBeUndefined()
  })

  test("preserves an empty string", () => {
    // `??` and not `||`: "" is a legal value, not an absent one. A `||` implementation
    // would silently turn a stored empty description into an absent key.
    expect(optional("")).toBe("")
  })

  test("preserves other falsy values", () => {
    expect(optional(0)).toBe(0)
    expect(optional(false)).toBe(false)
  })

  test("passes non-null values through unchanged", () => {
    expect(optional("1.0.0")).toBe("1.0.0")
  })
})

describe("sourceColumns / toSourceJson", () => {
  test("round-trips an npm source with a version", () => {
    const source: SourceJson = { type: "npm", package: "@lunos-community/conventional-commits", version: "1.2.3" }
    const columns = sourceColumns(source)

    expect(columns).toEqual({
      source_type: "npm",
      source_package: "@lunos-community/conventional-commits",
      source_version: "1.2.3",
      source_repo: null,
      source_ref: null,
    })
    expect(toSourceJson(columns)).toEqual(source)
  })

  test("round-trips an npm source without a version", () => {
    const source: SourceJson = { type: "npm", package: "@lunos-community/formatter" }
    const columns = sourceColumns(source)

    expect(columns.source_version).toBeNull()
    // The absent key comes back as `undefined`, never `null` (gotcha #2): a literal null
    // on the wire would break the client's Marketplace.decode.
    expect(toSourceJson(columns)).toEqual({ type: "npm", package: "@lunos-community/formatter", version: undefined })
  })

  test("round-trips a github source with a ref", () => {
    const source: SourceJson = { type: "github", repo: "lunos-community/rust-analyzer-bridge", ref: "v2" }
    const columns = sourceColumns(source)

    expect(columns).toEqual({
      source_type: "github",
      source_package: null,
      source_version: null,
      source_repo: "lunos-community/rust-analyzer-bridge",
      source_ref: "v2",
    })
    expect(toSourceJson(columns)).toEqual(source)
  })

  test("round-trips a github source without a ref", () => {
    const source: SourceJson = { type: "github", repo: "H2Shami/opencode-helicone-session" }
    const columns = sourceColumns(source)

    expect(columns.source_ref).toBeNull()
    expect(toSourceJson(columns)).toEqual({
      type: "github",
      repo: "H2Shami/opencode-helicone-session",
      ref: undefined,
    })
  })

  test("never populates both variants' columns", () => {
    // The DDL's CHECK constraint enforces this at write time; this asserts the mapper
    // never produces a row the constraint would reject.
    const npm = sourceColumns({ type: "npm", package: "p", version: "1" })
    expect(npm.source_repo).toBeNull()
    expect(npm.source_ref).toBeNull()

    const github = sourceColumns({ type: "github", repo: "o/r", ref: "main" })
    expect(github.source_package).toBeNull()
    expect(github.source_version).toBeNull()
  })

  test("throws on a corrupt npm row with a NULL package", () => {
    expect(() => toSourceJson({ ...nullColumns, source_type: "npm" })).toThrow(/source_package/)
  })

  test("throws on a corrupt github row with a NULL repo", () => {
    expect(() => toSourceJson({ ...nullColumns, source_type: "github" })).toThrow(/source_repo/)
  })

  test("throws on an unknown source_type", () => {
    expect(() => toSourceJson({ ...nullColumns, source_type: "archive" })).toThrow(/archive/)
  })
})

describe("matchesQuery", () => {
  test("matches the name case-insensitively", () => {
    expect(matchesQuery("HELICONE")(plugin({ name: "opencode-helicone-session" }))).toBe(true)
  })

  test("matches the description case-insensitively", () => {
    expect(matchesQuery("session headers")(plugin({ description: "Inject Helicone SESSION HEADERS" }))).toBe(true)
  })

  test("matches the category case-insensitively", () => {
    expect(matchesQuery("FORMAT")(plugin({ category: "formatting" }))).toBe(true)
  })

  test("matches any single tag case-insensitively", () => {
    expect(matchesQuery("Lint")(plugin({ tags: ["formatting", "LINTER"] }))).toBe(true)
  })

  test("an empty query matches everything (GAP-001)", () => {
    // Mirrors the client's `needle = "".toLowerCase()` -> `includes("")` -> always true.
    expect(matchesQuery("")(plugin())).toBe(true)
  })

  test("a whitespace-only query matches everything (GAP-001)", () => {
    // `trim()` reduces it to "", so it behaves exactly like the empty query.
    expect(matchesQuery("   ")(plugin())).toBe(true)
  })

  test("the query itself is trimmed before matching", () => {
    expect(matchesQuery("  helicone  ")(plugin({ name: "opencode-helicone-session" }))).toBe(true)
  })

  test("does NOT match on author", () => {
    // Deliberate exclusion — mirrors the client's searchPlugins haystack exactly.
    expect(matchesQuery("h2shami")(plugin({ name: "example", author: "H2Shami" }))).toBe(false)
  })

  test("does NOT match on marketplace", () => {
    expect(matchesQuery("community")(plugin({ marketplace: "lunos-community" }))).toBe(false)
  })

  test("returns false when nothing in the haystack matches", () => {
    expect(matchesQuery("nonexistent")(plugin())).toBe(false)
  })

  test("tolerates a plugin with every optional field absent", () => {
    const bare = plugin({ description: undefined, category: undefined, tags: undefined })
    expect(matchesQuery("example")(bare)).toBe(true)
    expect(matchesQuery("nope")(bare)).toBe(false)
  })
})
