import { describe, expect, test } from "bun:test"
import type { MarketplaceRecord, PluginRecord, RegistryReadDb } from "../db"
import { handleMarketplaces } from "./marketplaces"

/**
 * DI seam stand-in for the real D1 read side, same convention as `fakeReadDb` in
 * marketplace-json.test.ts. Records every call so a test can assert not just what was read
 * but what was NOT — this endpoint must never touch the plugin list, since `pluginCount`
 * arrives already aggregated on the record.
 */
function fakeReadDb(marketplaces: MarketplaceRecord[], plugins: PluginRecord[] = []) {
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
 * Asserting on the serialized body rather than on the pre-serialization object is
 * load-bearing here for two separate reasons (both of which a `toEqual` against the JS
 * object would silently forgive): `JSON.stringify` drops `undefined` keys but PRESERVES
 * `null` (gotcha #2), and bun:test's `toEqual` ignores `undefined`-valued properties
 * altogether. The raw text is kept as its own assertion target — a nested `null` inside
 * `owner` is visible there and nowhere else.
 */
async function invoke(db: RegistryReadDb) {
  const response = await handleMarketplaces({ url: new URL("https://registry.test/marketplaces"), db })
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as Record<string, unknown> }
}

const entries = (body: Record<string, unknown>) => body.marketplaces as Record<string, unknown>[]

/** Every optional present, including both optional `owner` sub-fields. */
const full: MarketplaceRecord = {
  name: "lunos-community",
  owner: { name: "Lunos", email: "hello@lunos.dev", url: "https://github.com/pminev1/Lunos" },
  description: "The seeded community marketplace.",
  version: "1.0.0",
  pluginCount: 36,
  source: "https://github.com/pminev1/Lunos",
}

/**
 * Every optional ABSENT — no `description`, no `version`, and an `owner` carrying neither
 * `email` nor `url`. This is the row that proves the nested optionals inside `owner` never
 * reach the wire as `null`.
 */
const minimal: MarketplaceRecord = {
  name: "another-marketplace",
  owner: { name: "Someone Else" },
  pluginCount: 0,
  source: "https://example.com/another",
}

describe("GET /marketplaces — happy path", () => {
  test("responds 200 with a JSON content type", async () => {
    const { response } = await invoke(fakeReadDb([full, minimal]).db)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  test("wraps the list in a `marketplaces` envelope and nothing else", async () => {
    // Unlike /marketplace.json's bare document, this response IS wrapped. Pinning the
    // top-level key set catches a stray `count`/`total` added later.
    const { body } = await invoke(fakeReadDb([full, minimal]).db)

    expect(Object.keys(body)).toEqual(["marketplaces"])
  })

  test("emits one entry per marketplace row, in listMarketplaces' order", async () => {
    const { body } = await invoke(fakeReadDb([full, minimal]).db)

    expect(entries(body)).toHaveLength(2)
    expect(entries(body).map((entry) => entry.name)).toEqual(["lunos-community", "another-marketplace"])
  })

  test("serializes a fully-populated row verbatim", async () => {
    const { body } = await invoke(fakeReadDb([full]).db)

    expect(entries(body)[0]).toEqual({
      name: "lunos-community",
      owner: { name: "Lunos", email: "hello@lunos.dev", url: "https://github.com/pminev1/Lunos" },
      description: "The seeded community marketplace.",
      version: "1.0.0",
      pluginCount: 36,
      source: "https://github.com/pminev1/Lunos",
    })
  })

  test("passes pluginCount through as the aggregate the record already carries", async () => {
    // Derived by LIST_MARKETPLACES_SQL's correlated COUNT, never a stored column and never
    // recomputed here — a handler that counted `listPlugins()` rows instead would report 0.
    const { calls, db } = fakeReadDb([full], [])

    const { body } = await invoke(db)

    expect(entries(body)[0].pluginCount).toBe(36)
    // The strongest form of the guarantee: the plugin list is not merely ignored, it is
    // never read.
    expect(calls).toEqual(["listMarketplaces"])
  })
})

describe("GET /marketplaces — field shape (contracts §4.4)", () => {
  test("a fully-populated entry emits exactly the six contracted fields", async () => {
    const { body } = await invoke(fakeReadDb([full]).db)

    // The KEY SET is the assertion, not a value comparison: `toEqual` ignores
    // `undefined`-valued properties, so it cannot by itself prove an extra key is absent.
    expect(Object.keys(entries(body)[0]).sort()).toEqual([
      "description",
      "name",
      "owner",
      "pluginCount",
      "source",
      "version",
    ])
  })

  test("an entry with every optional absent emits exactly the four required fields", async () => {
    const { body } = await invoke(fakeReadDb([minimal]).db)

    expect(Object.keys(entries(body)[0]).sort()).toEqual(["name", "owner", "pluginCount", "source"])
  })

  test("an owner with no email or url emits exactly its name", async () => {
    // `owner` is the one NESTED optional surface on this endpoint, and the only place a
    // `null` leak could hide from a top-level key-set check.
    const { body } = await invoke(fakeReadDb([minimal]).db)

    expect(Object.keys(entries(body)[0].owner as Record<string, unknown>)).toEqual(["name"])
  })

  test("no null appears anywhere in the serialized response", async () => {
    const { text } = await invoke(fakeReadDb([full, minimal]).db)

    expect(text).not.toContain("null")
  })
})

describe("GET /marketplaces — empty D1", () => {
  test("responds 200 with an empty marketplaces array, never 404", async () => {
    const { response, body } = await invoke(fakeReadDb([]).db)

    expect(response.status).toBe(200)
    expect(body).toEqual({ marketplaces: [] })
  })
})

describe("GET /marketplaces — D1 failure", () => {
  test("lets the error propagate rather than catching it", async () => {
    // Handlers must NOT catch D1 errors (gotcha #8): the uniform 500 envelope comes from the
    // router's single try/catch. router.test.ts asserts the other half of this.
    const db: RegistryReadDb = {
      async listMarketplaces() {
        throw new Error("D1_ERROR: no such table: marketplace")
      },
      async listPlugins() {
        throw new Error("unreachable")
      },
    }

    await expect(handleMarketplaces({ url: new URL("https://registry.test/marketplaces"), db })).rejects.toThrow(
      /no such table/,
    )
  })
})
