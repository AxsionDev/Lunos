import { describe, expect, test } from "bun:test"
import type { MarketplaceRecord, PluginRecord, RegistryReadDb } from "../db"
import { handlePlugins } from "./plugins"
import { handlePluginsSearch } from "./plugins-search"

/**
 * DI seam stand-in for the real D1 read side, same convention as `fakeReadDb` in
 * plugins.test.ts — except that this one APPLIES the filter it is handed, because applying it
 * is the whole subject of this file. `calls` records every read so a test can assert that the
 * absent-`q` branch short-circuits before touching D1 at all, and that the marketplace table
 * is never consulted.
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
 * `query` is appended RAW so a test can express `?q=` (present, empty) and `?q=%20%20`
 * (present, whitespace) — two cases that `URLSearchParams`-based construction would blur, and
 * that GAP-001 distinguishes from `q` being absent entirely.
 *
 * Asserting on the serialized body matters here for the same reason it does in plugins.test.ts:
 * bun:test's `toEqual` ignores `undefined`-valued properties, so only a post-`JSON.stringify`
 * key set can state "no `author` key" as a wire fact.
 */
async function invoke(db: RegistryReadDb, query = "") {
  const response = await handlePluginsSearch({ url: new URL(`https://registry.test/plugins/search${query}`), db })
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as Record<string, unknown> }
}

const entries = (body: Record<string, unknown>) => body.plugins as Record<string, unknown>[]
const names = (body: Record<string, unknown>) => entries(body).map((entry) => entry.name)

function plugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    marketplace: "lunos-community",
    name: "example-plugin",
    source: { type: "github", repo: "lunos-community/example" },
    ...overrides,
  }
}

/**
 * One fixture per searchable field, each carrying its distinctive token in EXACTLY ONE field,
 * so a query for that token proves which field was searched rather than merely that something
 * matched. The real seed is 100% github-sourced with no category/tags/author/version at all
 * (gotcha #9), so every branch below is necessarily synthetic.
 */
const populated: PluginRecord[] = [
  plugin({ name: "tokenname-plugin" }),
  plugin({ name: "second-plugin", description: "Carries the tokendescription marker." }),
  plugin({ name: "third-plugin", category: "tokencategory" }),
  plugin({ name: "fourth-plugin", tags: ["tokentag", "unrelated"] }),
]

/**
 * THE EXCLUSION FIXTURE. `author` and `marketplace` are the two fields the client's
 * `searchPlugins` haystack deliberately omits, and this record is the only way to prove the
 * omission: its tokens appear in those two fields and NOWHERE in name/description/category/tags.
 *
 * Reusing `populated` for this would have proved nothing — a fixture whose author token also
 * occurs in its own name matches via the name and the "no match" assertion would fail for a
 * reason that has nothing to do with the exclusion.
 */
const excluded = plugin({
  marketplace: "onlyinmarketplace",
  name: "ordinary-plugin",
  description: "An ordinary description.",
  category: "formatting",
  tags: ["formatting"],
  author: "onlyinauthor",
  version: "9.9.9",
})

describe("GET /plugins/search — `q` absent entirely (GAP-001)", () => {
  test("responds 400 with the uniform error envelope", async () => {
    const { response, body } = await invoke(fakeReadDb(populated).db)

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: "Missing required query parameter: q" })
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  test("short-circuits before D1 is touched at all", async () => {
    // The guard is a pure URL check: an absent `q` must not cost a query.
    const { calls, db } = fakeReadDb(populated)

    await invoke(db)

    expect(calls).toEqual([])
  })

  test("another parameter present but no `q` is still a 400", async () => {
    // `has("q")` and not "are there any params" — a URL that carries `?limit=10` is exactly as
    // missing its required parameter as a bare one.
    const { response } = await invoke(fakeReadDb(populated).db, "?limit=10")

    expect(response.status).toBe(400)
  })
})

describe("GET /plugins/search — `q` present but empty or whitespace (GAP-001)", () => {
  /**
   * The other half of GAP-001, and the reason the guard above tests `has()` rather than the
   * truthiness of `get()`: `""` is falsy but is a LEGAL query meaning "match everything",
   * matching the client's `needle = "".trim().toLowerCase()` -> `includes("")` -> always true.
   */
  test.each([
    ["?q=", "empty"],
    ["?q=%20%20", "whitespace-only"],
    ["?q=%09", "a tab"],
  ])("%s (%s) responds 200 with every plugin", async (query) => {
    const { response, body } = await invoke(fakeReadDb(populated).db, query)

    expect(response.status).toBe(200)
    expect(names(body)).toEqual(populated.map((record) => record.name))
  })

  test("the empty-`q` response is byte-identical to `GET /plugins`' own response", async () => {
    // The strongest available statement of §4.4's "identical to GET /plugins": one assertion
    // covering the envelope key, the field list, field ORDER, and the absence of any wrapper —
    // and it is what the shared `toPluginEntry` import exists to guarantee.
    const all = [...populated, excluded]
    const plugins = await handlePlugins({ url: new URL("https://registry.test/plugins"), db: fakeReadDb(all).db })
    const search = await handlePluginsSearch({
      url: new URL("https://registry.test/plugins/search?q="),
      db: fakeReadDb(all).db,
    })

    expect(await search.text()).toBe(await plugins.text())
  })
})

describe("GET /plugins/search — the searched fields are name, description, category and tags", () => {
  // Tuple order is [needle, field, expectedName], NOT [needle, expectedName, field]: printf
  // substitution in the title consumes row elements POSITIONALLY, so the second `%s` takes the
  // second element regardless of what the callback binds it to. With the fields second, these
  // four titles render as "...carrying it in its description field" — which is the sentence a
  // reviewer reads to confirm the per-field AC is covered.
  test.each([
    ["tokenname", "name", "tokenname-plugin"],
    ["tokendescription", "description", "second-plugin"],
    ["tokencategory", "category", "third-plugin"],
    ["tokentag", "tags", "fourth-plugin"],
  ])("`q=%s` matches only the fixture carrying it in its %s field", async (needle, _field, expected) => {
    const { response, body } = await invoke(fakeReadDb(populated).db, `?q=${needle}`)

    expect(response.status).toBe(200)
    expect(names(body)).toEqual([expected])
  })

  test("matching is a case-insensitive substring, not an equality check", async () => {
    const { body } = await invoke(fakeReadDb(populated).db, "?q=TOKENCAT")

    expect(names(body)).toEqual(["third-plugin"])
  })

  test("the needle is trimmed, so surrounding whitespace does not defeat a match", async () => {
    const { body } = await invoke(fakeReadDb(populated).db, "?q=%20tokenname%20")

    expect(names(body)).toEqual(["tokenname-plugin"])
  })

  test("a query matching several fixtures returns all of them in listPlugins' order", async () => {
    const { body } = await invoke(fakeReadDb(populated).db, "?q=plugin")

    expect(names(body)).toEqual(populated.map((record) => record.name))
  })

  test("the predicate is pushed into listPlugins rather than applied after the fact", async () => {
    // Filtering goes through `listPlugins`' own `filter` option (contracts §1.4), which is what
    // keeps a future move of the predicate into SQL behind the `RegistryReadDb` seam. The
    // marketplace table is never consulted.
    const { calls, db } = fakeReadDb(populated)
    let received: unknown

    await handlePluginsSearch({
      url: new URL("https://registry.test/plugins/search?q=tokenname"),
      db: {
        ...db,
        async listPlugins(options) {
          received = options?.filter
          return db.listPlugins(options)
        },
      },
    })

    expect(typeof received).toBe("function")
    expect(calls).toEqual(["listPlugins"])
  })
})

describe("GET /plugins/search — `author` and `marketplace` are NOT searched", () => {
  /**
   * The exclusion this story calls out explicitly. The client's `searchPlugins` haystack omits
   * both fields, and a server that searched them would make the same query return different
   * results depending on which side ran it — the exact inconsistency §2.5 exists to prevent.
   */
  test("the fixture genuinely carries both tokens, so the assertions have teeth", async () => {
    expect(excluded.author).toBe("onlyinauthor")
    expect(excluded.marketplace).toBe("onlyinmarketplace")
    // ...and nowhere else, which is what makes a non-match attributable to the exclusion.
    const searched = [excluded.name, excluded.description, excluded.category, ...(excluded.tags ?? [])].join(" ")
    expect(searched).not.toContain("onlyin")
  })

  test.each(["onlyinauthor", "onlyinmarketplace"])("`q=%s` matches nothing", async (needle) => {
    const { response, body } = await invoke(fakeReadDb([excluded]).db, `?q=${needle}`)

    expect(response.status).toBe(200)
    expect(body).toEqual({ plugins: [] })
  })

  test("the same fixture DOES match on a field that is searched", async () => {
    // The control: the two assertions above fail for the right reason only if this passes.
    const { body } = await invoke(fakeReadDb([excluded]).db, "?q=formatting")

    expect(names(body)).toEqual(["ordinary-plugin"])
  })
})

describe("GET /plugins/search — response shape is identical to GET /plugins (§4.4)", () => {
  test("wraps the matches in a `plugins` envelope and nothing else", async () => {
    const { body } = await invoke(fakeReadDb(populated).db, "?q=plugin")

    expect(Object.keys(body)).toEqual(["plugins"])
  })

  test("a fully-populated match emits exactly the six contracted fields", async () => {
    const { body } = await invoke(fakeReadDb([excluded]).db, "?q=formatting")

    expect(Object.keys(entries(body)[0]).sort()).toEqual([
      "category",
      "description",
      "marketplace",
      "name",
      "source",
      "tags",
    ])
  })

  test("`author` and the top-level `version` never reach the wire", async () => {
    // Gotcha #5, inherited rather than re-implemented: this endpoint shares `toPluginEntry`
    // with `GET /plugins`, so the omission cannot drift between the two.
    const { text, body } = await invoke(fakeReadDb([excluded]).db, "?q=formatting")

    expect(entries(body)[0]).not.toHaveProperty("author")
    expect(entries(body)[0]).not.toHaveProperty("version")
    expect(text).not.toContain('"author"')
    expect(text).not.toContain("onlyinauthor")
    expect(text).not.toContain("9.9.9")
  })

  test("`source` stays the raw tagged union, never an install-spec string", async () => {
    const npm = plugin({ name: "npm-plugin", source: { type: "npm", package: "@synthetic/plugin", version: "1.2.3" } })
    const { body } = await invoke(fakeReadDb([npm]).db, "?q=npm-plugin")

    expect(entries(body)[0].source).toEqual({ type: "npm", package: "@synthetic/plugin", version: "1.2.3" })
  })

  test("no null appears anywhere in the serialized response", async () => {
    // Absent optionals are absent KEYS, never literal nulls (gotcha #2).
    const { text } = await invoke(fakeReadDb(populated).db, "?q=plugin")

    expect(text).not.toContain("null")
  })
})

describe("GET /plugins/search — no matches", () => {
  test("responds 200 with an empty plugins array, never 404", async () => {
    // Called out directly in XCOD-33's spec: "no plugins matched" is an empty result, not a
    // missing resource.
    const { response, body } = await invoke(fakeReadDb(populated).db, "?q=nothingmatchesthis")

    expect(response.status).toBe(200)
    expect(body).toEqual({ plugins: [] })
  })

  test("an empty D1 responds the same way for a real query", async () => {
    const { response, body } = await invoke(fakeReadDb([]).db, "?q=anything")

    expect(response.status).toBe(200)
    expect(body).toEqual({ plugins: [] })
  })
})

describe("GET /plugins/search — D1 failure", () => {
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

    await expect(
      handlePluginsSearch({ url: new URL("https://registry.test/plugins/search?q=anything"), db }),
    ).rejects.toThrow(/no such table/)
  })
})
