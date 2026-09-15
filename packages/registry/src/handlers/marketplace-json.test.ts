import { describe, expect, test } from "bun:test"
import { Marketplace } from "@opencode-ai/core/marketplace"
import {
  REGISTRY_MANIFEST_NAME,
  REGISTRY_MANIFEST_OWNER,
  type MarketplaceRecord,
  type PluginRecord,
  type RegistryReadDb,
} from "../db"
import { handleMarketplaceJson } from "./marketplace-json"

/**
 * VALUE import of `@opencode-ai/core/marketplace` is correct HERE and only here — this file
 * runs under Bun, never inside the Worker, so pulling `effect` in for `Marketplace.decode`
 * costs the Worker bundle nothing (gotcha #3). `marketplace-json.ts` itself imports no
 * value from that module, directly or transitively.
 */

/**
 * DI seam stand-in for the real D1 read side, same convention as `fakeWriteDb` in
 * seed.test.ts. Records every call so a test can assert not just what was read but what was
 * NOT: the fixed top-level identity must never come from `listMarketplaces`.
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
 * Asserting on `await response.json()` rather than on the pre-serialization object is
 * load-bearing: the whole `optional()` discipline (gotcha #2) is about `JSON.stringify`
 * dropping `undefined` while preserving `null`. The derived types admit `| undefined`, so a
 * `null` leak would sail through an assertion made against the JS object and only fail on
 * the wire, inside the client's `Marketplace.decode`.
 */
async function invoke(db: RegistryReadDb) {
  const response = await handleMarketplaceJson({ url: new URL("https://registry.test/marketplace.json"), db })
  // Read the body ONCE, as text, then parse: a Response body is single-use, and the raw
  // text is itself an assertion target (a leaked `null` is visible there and nowhere else).
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as Record<string, unknown> }
}

/**
 * A plugin row as `listPlugins` hands it over: denormalized with its parent marketplace.
 * `marketplace` is deliberately `"lunos-community"` — the SEEDED manifest's identity, which
 * is NOT the registry's own.
 */
function plugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    marketplace: "lunos-community",
    name: "example-plugin",
    source: { type: "github", repo: "lunos-community/example" },
    ...overrides,
  }
}

const populated: PluginRecord[] = [
  plugin({
    name: "opencode-helicone-session",
    source: { type: "github", repo: "H2Shami/opencode-helicone-session" },
    description: "Inject Helicone session headers.",
    author: "H2Shami",
  }),
  plugin({
    name: "synthetic-npm-plugin",
    source: { type: "npm", package: "@synthetic/plugin", version: "1.2.3" },
    description: "An npm-sourced plugin with a category and tags.",
    // Entry.version (9.9.9) vs. NpmSource.version (1.2.3) — two DISTINCT fields carried
    // side by side so a projection that conflates them fails loudly (gotcha #6).
    version: "9.9.9",
    author: "Synthetic Author",
    category: "formatting",
    tags: ["formatting", "linting"],
  }),
  // Every optional absent — the shape the real seed file produces for all 36 of its rows.
  plugin({ name: "bare-plugin", source: { type: "github", repo: "lunos-community/bare" } }),
]

describe("GET /marketplace.json — happy path", () => {
  test("responds 200 with a JSON content type", async () => {
    const { response } = await invoke(fakeReadDb(populated).db)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  test("round-trips cleanly through Marketplace.decode", async () => {
    // XCOD-34's Jira AC #2 ("payloads validate against the XCOD-8 schema") at the unit
    // level. `Marketplace.decode` is the EXACT call the client's resolveMarketplaceManifest
    // makes on this payload, so a decode failure here is a broken `marketplace add`.
    const { body } = await invoke(fakeReadDb(populated).db)

    const manifest = Marketplace.decode(body)

    expect(manifest.name).toBe(REGISTRY_MANIFEST_NAME)
    expect(manifest.plugins.length).toBe(populated.length)
  })

  test("emits zero extra top-level fields", async () => {
    // Any wrapper key breaks the client's decode. `description`, `version` and `$schema`
    // are omitted rather than invented: GAP-002 resolved only `name` and `owner` (§4.4).
    const { body } = await invoke(fakeReadDb(populated).db)

    expect(Object.keys(body).sort()).toEqual(["name", "owner", "plugins"])
  })

  test("projects every Entry field through, in every source variant", async () => {
    const { body } = await invoke(fakeReadDb(populated).db)
    const entries = body.plugins as Record<string, unknown>[]

    expect(entries[1]).toEqual({
      name: "synthetic-npm-plugin",
      source: { type: "npm", package: "@synthetic/plugin", version: "1.2.3" },
      description: "An npm-sourced plugin with a category and tags.",
      version: "9.9.9",
      author: "Synthetic Author",
      category: "formatting",
      tags: ["formatting", "linting"],
    })
    expect(entries[0].source).toEqual({ type: "github", repo: "H2Shami/opencode-helicone-session" })
  })

  test("preserves listPlugins' ordering", async () => {
    const { body } = await invoke(fakeReadDb(populated).db)
    const entries = body.plugins as Record<string, unknown>[]

    expect(entries.map((entry) => entry.name)).toEqual(populated.map((record) => record.name))
  })

  test("aggregates across every marketplace — no filter is applied", async () => {
    // The registry's own manifest is the union of EVERY ingested marketplace's plugins.
    const multiSourced = [...populated, plugin({ marketplace: "another-marketplace", name: "from-elsewhere" })]
    const { body } = await invoke(fakeReadDb(multiSourced).db)

    expect((body.plugins as unknown[]).length).toBe(multiSourced.length)
  })
})

describe("GET /marketplace.json — fixed registry identity (GAP-002)", () => {
  /**
   * THE regression test C-001's AC calls out by name. The fake is seeded with a marketplace
   * whose identity differs from the registry's on BOTH fields:
   *
   *  - `name: "lunos-community"` — also carried on every PluginRecord's `marketplace` field,
   *    which is the value actually reachable from inside this handler and therefore the real
   *    pass-through vector (`plugins[0].marketplace` leaking into the top-level `name`).
   *  - a deliberately DIFFERENT `owner`. The real seed's owner is byte-identical to
   *    REGISTRY_MANIFEST_OWNER (gotcha #4: three independent values that happen to share a
   *    string today), so reusing it here would make an owner pass-through bug invisible.
   */
  const seeded: MarketplaceRecord = {
    name: "lunos-community",
    owner: { name: "Someone Else", url: "https://example.com/someone-else" },
    description: "The seeded community marketplace — NOT the registry itself.",
    version: "1.0.0",
    pluginCount: populated.length,
    source: "https://github.com/pminev1/Lunos",
  }

  test("top-level name is the fixed constant, not the seeded marketplace's name", async () => {
    const { body } = await invoke(fakeReadDb(populated, [seeded]).db)

    expect(body.name).toBe("lunos-registry")
    expect(body.name).not.toBe(seeded.name)
    // Every plugin row carries "lunos-community" — proving the leak vector was present and
    // still did not reach the top level.
    expect(populated.every((record) => record.marketplace === seeded.name)).toBe(true)
  })

  test("top-level owner is the fixed constant, not the seeded marketplace's owner", async () => {
    const { body } = await invoke(fakeReadDb(populated, [seeded]).db)

    expect(body.owner).toEqual(REGISTRY_MANIFEST_OWNER)
    expect(body.owner).not.toEqual(seeded.owner)
  })

  test("never consults listMarketplaces at all", async () => {
    // The strongest form of the guarantee: the seeded identity is not merely ignored, it is
    // never read. Nothing that could leak is ever in scope.
    const { calls, db } = fakeReadDb(populated, [seeded])

    await invoke(db)

    expect(calls).toEqual(["listPlugins"])
  })

  test("entries never carry the denormalized marketplace field", async () => {
    // `marketplace` is registry-native; `Marketplace.Entry` has no such field. Leaving it on
    // would put an unknown key inside each entry of a document whose contract is a bare,
    // decode-valid Manifest.
    const { body } = await invoke(fakeReadDb(populated, [seeded]).db)

    for (const entry of body.plugins as Record<string, unknown>[]) {
      expect(entry).not.toHaveProperty("marketplace")
    }
  })
})

describe("GET /marketplace.json — absent optionals never reach the wire as null", () => {
  test("an entry with every optional absent serializes to exactly name + source", async () => {
    const { body } = await invoke(fakeReadDb([plugin({ name: "bare-plugin" })]).db)
    const [entry] = body.plugins as Record<string, unknown>[]

    // Not `toEqual` on the object alone: that would pass for `{ description: null }` in a
    // loose comparison. The KEY SET is the assertion — `undefined` keys are dropped by
    // JSON.stringify, `null` keys are not (gotcha #2).
    expect(Object.keys(entry)).toEqual(["name", "source"])
  })

  test("no null appears anywhere in the serialized document", async () => {
    const { text } = await invoke(fakeReadDb(populated).db)

    expect(text).not.toContain("null")
  })
})

describe("GET /marketplace.json — empty D1", () => {
  test("responds 200 with an empty plugins array, never 404", async () => {
    const { response, body } = await invoke(fakeReadDb([]).db)

    expect(response.status).toBe(200)
    expect(body.plugins).toEqual([])
  })

  test("the empty document still decodes and keeps the fixed identity", async () => {
    // `plugins: []` is a valid, schema-conformant empty array — `marketplace add` against a
    // freshly-provisioned, unseeded registry must succeed, not error.
    const { body } = await invoke(fakeReadDb([]).db)

    const manifest = Marketplace.decode(body)

    expect(manifest.name).toBe(REGISTRY_MANIFEST_NAME)
    expect(manifest.owner).toEqual(REGISTRY_MANIFEST_OWNER)
    expect(manifest.plugins).toEqual([])
  })
})

describe("GET /marketplace.json — D1 failure", () => {
  test("lets the error propagate rather than catching it", async () => {
    // Handlers must NOT catch D1 errors (gotcha #8): the uniform 500 envelope comes from
    // the router's single try/catch. router.test.ts asserts the other half of this.
    const db: RegistryReadDb = {
      async listMarketplaces() {
        throw new Error("unreachable")
      },
      async listPlugins() {
        throw new Error("D1_ERROR: no such table: plugin")
      },
    }

    await expect(handleMarketplaceJson({ url: new URL("https://registry.test/marketplace.json"), db })).rejects.toThrow(
      /no such table/,
    )
  })
})
