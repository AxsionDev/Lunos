import { describe, expect, test } from "bun:test"
import type { MarketplaceRecord, PluginRecord, RegistryReadDb } from "../db"
import { handlePlugins } from "./plugins"

/**
 * DI seam stand-in for the real D1 read side, same convention as `fakeReadDb` in
 * marketplace-json.test.ts. Records every call so a test can assert that no filter is
 * applied and that the marketplace table is never consulted.
 */
function fakeReadDb(plugins: PluginRecord[], marketplaces: MarketplaceRecord[] = []) {
  const calls: string[] = []
  const db: RegistryReadDb = {
    async listMarketplaces() {
      calls.push("listMarketplaces")
      return marketplaces
    },
    async listPlugins(options) {
      calls.push("listPlugins")
      return options?.filter ? plugins.filter(options.filter) : plugins
    },
  }
  return { calls, db }
}

/**
 * Drives the handler exactly as the router does and returns the PARSED WIRE BODY.
 *
 * Asserting on the serialized body is what makes this file's central claim testable at all.
 * bun:test's `toEqual` IGNORES `undefined`-valued properties, so a handler that emitted
 * `author: undefined` would pass a `toEqual` against the pre-serialization object — and
 * `not.toHaveProperty("author")` would fail against it even for correct code. Once the
 * object has been through `JSON.stringify`, an `undefined` key is simply gone and the key
 * set states the requirement directly. The raw text is kept as its own assertion target.
 */
async function invoke(db: RegistryReadDb) {
  const response = await handlePlugins({ url: new URL("https://registry.test/plugins"), db })
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as Record<string, unknown> }
}

const entries = (body: Record<string, unknown>) => body.plugins as Record<string, unknown>[]

function plugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    marketplace: "lunos-community",
    name: "example-plugin",
    source: { type: "github", repo: "lunos-community/example" },
    ...overrides,
  }
}

/**
 * The real seed file is 100% `source.type: "github"` with zero `category`, `tags`, `author`
 * or `version` values (gotcha #9), so those branches exist ONLY in synthetic fixtures. The
 * npm entry below is that fixture, and it deliberately carries both fields this endpoint
 * must drop, as defined non-empty strings — a projection that leaked them would otherwise
 * have nothing to leak.
 */
const populated: PluginRecord[] = [
  plugin({
    name: "opencode-helicone-session",
    source: { type: "github", repo: "H2Shami/opencode-helicone-session" },
    description: "Inject Helicone session headers.",
    author: "H2Shami",
  }),
  plugin({
    marketplace: "another-marketplace",
    name: "synthetic-npm-plugin",
    source: { type: "npm", package: "@synthetic/plugin", version: "1.2.3" },
    description: "An npm-sourced plugin with a category and tags.",
    // Entry.version (9.9.9) vs. NpmSource.version (1.2.3) — two DISTINCT fields carried side
    // by side (gotcha #6). Entry.version must be dropped; NpmSource.version must survive
    // INSIDE `source`. A projection that conflates them fails loudly on both counts.
    version: "9.9.9",
    author: "Synthetic Author",
    category: "formatting",
    tags: ["formatting", "linting"],
  }),
  // Every optional absent — the shape the real seed file produces for all 36 of its rows.
  plugin({ name: "bare-plugin", source: { type: "github", repo: "lunos-community/bare" } }),
]

describe("GET /plugins — happy path", () => {
  test("responds 200 with a JSON content type", async () => {
    const { response } = await invoke(fakeReadDb(populated).db)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  test("wraps the list in a `plugins` envelope and nothing else", async () => {
    const { body } = await invoke(fakeReadDb(populated).db)

    expect(Object.keys(body)).toEqual(["plugins"])
  })

  test("flattens every plugin across every marketplace, in listPlugins' order", async () => {
    const { calls, db } = fakeReadDb(populated)

    const { body } = await invoke(db)

    expect(entries(body).map((entry) => entry.name)).toEqual(populated.map((record) => record.name))
    // No filter is applied — filtering is C-003's concern, and the marketplace table is
    // never consulted.
    expect(calls).toEqual(["listPlugins"])
  })

  test("keeps the denormalized marketplace field on every entry", async () => {
    // Unlike /marketplace.json's `Entry` objects, `marketplace` is part of THIS contract —
    // it is how a client attributes a flattened row to its parent.
    const { body } = await invoke(fakeReadDb(populated).db)

    expect(entries(body).map((entry) => entry.marketplace)).toEqual([
      "lunos-community",
      "another-marketplace",
      "lunos-community",
    ])
  })

  test("serializes a fully-populated npm entry with category and tags", async () => {
    const { body } = await invoke(fakeReadDb(populated).db)

    expect(entries(body)[1]).toEqual({
      name: "synthetic-npm-plugin",
      marketplace: "another-marketplace",
      description: "An npm-sourced plugin with a category and tags.",
      category: "formatting",
      tags: ["formatting", "linting"],
      source: { type: "npm", package: "@synthetic/plugin", version: "1.2.3" },
    })
  })

  test("preserves `source` as the raw tagged union, never an install-spec string", async () => {
    // The client-side `PluginListEntry` collapses `source` into a `spec` string; this
    // endpoint must NOT (C-001's reuse note). Both variants are checked.
    const { body } = await invoke(fakeReadDb(populated).db)

    expect(entries(body)[0].source).toEqual({ type: "github", repo: "H2Shami/opencode-helicone-session" })
    expect(entries(body)[1].source).toEqual({ type: "npm", package: "@synthetic/plugin", version: "1.2.3" })
  })

  test("an explicitly-empty tag list round-trips as an empty array", async () => {
    // `[]` is a distinct, legal value — NULL means "key absent", `'[]'` does not.
    const { body } = await invoke(fakeReadDb([plugin({ tags: [] })]).db)

    expect(entries(body)[0].tags).toEqual([])
  })
})

describe("GET /plugins — author and version are OMITTED (contracts §4.4, gotcha #5)", () => {
  /**
   * THE trap this story exists to avoid. `PluginRecord` carries `author` and `version`
   * because `/marketplace.json`'s `Entry` objects need them; this response must not, because
   * the client's own `PluginListEntry` carries neither. A naive rest spread leaks both.
   *
   * Every fixture below has BOTH fields set to defined, non-empty, distinctive strings, so
   * the assertions have something real to catch.
   */
  test("the fixture genuinely carries author and version, so the assertions have teeth", async () => {
    expect(populated[1].author).toBe("Synthetic Author")
    expect(populated[1].version).toBe("9.9.9")
  })

  test("no entry has an `author` key", async () => {
    const { body } = await invoke(fakeReadDb(populated).db)

    for (const entry of entries(body)) {
      expect(entry).not.toHaveProperty("author")
    }
  })

  test("no entry has a top-level `version` key", async () => {
    const { body } = await invoke(fakeReadDb(populated).db)

    for (const entry of entries(body)) {
      expect(entry).not.toHaveProperty("version")
    }
  })

  test("a fully-populated entry emits exactly the six contracted fields", async () => {
    // The KEY SET is the primary assertion: it states §4.4's field list directly and cannot
    // be weakened by a matcher's leniency toward `undefined`.
    const { body } = await invoke(fakeReadDb(populated).db)

    expect(Object.keys(entries(body)[1]).sort()).toEqual([
      "category",
      "description",
      "marketplace",
      "name",
      "source",
      "tags",
    ])
  })

  test("neither the author key nor its value appears anywhere on the wire", async () => {
    const { text } = await invoke(fakeReadDb(populated).db)

    expect(text).not.toContain('"author"')
    // A value-level check too, since a renamed-but-still-emitted key would slip past the
    // key check above. `"H2Shami"` is deliberately NOT asserted on: that author's name is a
    // substring of its own `source.repo`, which legitimately does appear.
    expect(text).not.toContain("Synthetic Author")
  })

  test("Entry.version is dropped while NpmSource.version survives inside `source`", async () => {
    // Gotcha #6 as a wire-level discriminator: the two fields are distinct, and exactly one
    // of them belongs in this response.
    const { text, body } = await invoke(fakeReadDb(populated).db)

    expect(text).not.toContain("9.9.9")
    expect(text).toContain("1.2.3")
    expect((entries(body)[1].source as Record<string, unknown>).version).toBe("1.2.3")
  })
})

describe("GET /plugins — absent optionals never reach the wire as null", () => {
  test("an entry with every optional absent serializes to exactly name, marketplace and source", async () => {
    const { body } = await invoke(fakeReadDb([plugin({ name: "bare-plugin" })]).db)

    expect(Object.keys(entries(body)[0]).sort()).toEqual(["marketplace", "name", "source"])
  })

  test("no null appears anywhere in the serialized response", async () => {
    const { text } = await invoke(fakeReadDb(populated).db)

    expect(text).not.toContain("null")
  })
})

describe("GET /plugins — empty D1", () => {
  test("responds 200 with an empty plugins array, never 404", async () => {
    const { response, body } = await invoke(fakeReadDb([]).db)

    expect(response.status).toBe(200)
    expect(body).toEqual({ plugins: [] })
  })
})

describe("GET /plugins — D1 failure", () => {
  test("lets the error propagate rather than catching it", async () => {
    // Handlers must NOT catch D1 errors (gotcha #8): the uniform 500 envelope comes from the
    // router's single try/catch. router.test.ts asserts the other half of this.
    const db: RegistryReadDb = {
      async listMarketplaces() {
        throw new Error("unreachable")
      },
      async listPlugins() {
        throw new Error("D1_ERROR: no such table: plugin")
      },
    }

    await expect(handlePlugins({ url: new URL("https://registry.test/plugins"), db })).rejects.toThrow(/no such table/)
  })
})
