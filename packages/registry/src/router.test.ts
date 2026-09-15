import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { MarketplaceRecord, PluginRecord, RegistryReadDb } from "./db"
import { handleRequest } from "./router"

const plugins: PluginRecord[] = [
  {
    marketplace: "lunos-community",
    name: "example-plugin",
    source: { type: "github", repo: "lunos-community/example" },
  },
]

/** C-002: non-empty so `GET /marketplaces`' dispatch test asserts on real content. */
const marketplaces: MarketplaceRecord[] = [
  {
    name: "lunos-community",
    owner: { name: "Lunos", url: "https://github.com/pminev1/Lunos" },
    pluginCount: plugins.length,
    source: "https://github.com/pminev1/Lunos",
  },
]

const okDb: RegistryReadDb = {
  async listMarketplaces() {
    return marketplaces
  },
  async listPlugins() {
    return plugins
  },
}

/** Every read rejects, standing in for a D1 query failure or an unavailable binding. */
const failingDb: RegistryReadDb = {
  async listMarketplaces() {
    throw new Error("D1_ERROR: no such table: marketplace")
  },
  async listPlugins() {
    throw new Error("D1_ERROR: no such table: plugin at offset 0 in SELECT marketplace_name, name FROM plugin")
  },
}

const request = (path: string, method = "GET") => new Request(`https://registry.test${path}`, { method })

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

describe("router — dispatch", () => {
  test("routes GET /marketplace.json to its handler", async () => {
    const response = await handleRequest(request("/marketplace.json"), okDb)

    expect(response.status).toBe(200)
    expect((await json(response)).name).toBe("lunos-registry")
  })

  test("routes GET /marketplaces to its handler", async () => {
    const response = await handleRequest(request("/marketplaces"), okDb)

    expect(response.status).toBe(200)
    expect((await json(response)).marketplaces).toHaveLength(marketplaces.length)
  })

  test("routes GET /plugins to its handler", async () => {
    const response = await handleRequest(request("/plugins"), okDb)

    expect(response.status).toBe(200)
    expect((await json(response)).plugins).toHaveLength(plugins.length)
  })

  test("routes GET /plugins/search to its handler, query string and all", async () => {
    // C-003. `/plugins` is a sibling key and never shadows this one — `routes` is an exact
    // pathname map, not a prefix matcher.
    const response = await handleRequest(request("/plugins/search?q=example"), okDb)

    expect(response.status).toBe(200)
    expect((await json(response)).plugins).toHaveLength(plugins.length)
  })

  test("the query string is not part of the routed path", async () => {
    // `url.pathname` excludes the search, so dispatch is unaffected by it — and the handler
    // still SEES it, which is what turns an absent `q` into its own 400 rather than a 404.
    const response = await handleRequest(request("/plugins/search"), okDb)

    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ error: "Missing required query parameter: q" })
  })
})

describe("router — unmatched paths (404)", () => {
  test("an unknown path responds 404 with the JSON error envelope", async () => {
    const response = await handleRequest(request("/nope"), okDb)

    expect(response.status).toBe(404)
    // The documented deviation from stat.ts's plain-text precedent (§4.3): the status code
    // is kept, the body is the uniform JSON envelope, so EVERY response from this Worker is
    // application/json.
    expect(await json(response)).toEqual({ error: "Not Found" })
    expect(response.headers.get("content-type")).toContain("application/json")
  })

  test("the root path responds 404", async () => {
    expect((await handleRequest(request("/"), okDb)).status).toBe(404)
  })

  test("a trailing slash is NOT normalised", async () => {
    // Exact pathname equality only. Deliberate: KISS, and no client produces it.
    expect((await handleRequest(request("/marketplace.json/"), okDb)).status).toBe(404)
  })

  test("a trailing slash on the search path is not normalised either", async () => {
    // C-003 REPLACED the "/plugins/search 404s until its handler lands" test that stood here
    // through C-001 and C-002. That assertion was a temporal marker of what was not yet
    // deployed — its own comment said so — and all four contracted paths are now routed, so
    // there is nothing left for it to mark. Its positive dispatch is asserted above; what
    // survives here is the genuinely invariant half, exact-pathname matching.
    expect((await handleRequest(request("/plugins/search/"), okDb)).status).toBe(404)
  })
})

describe("router — wrong method on a matched path (405)", () => {
  test("POST /marketplace.json responds 405 with the JSON envelope and an Allow header", async () => {
    const response = await handleRequest(request("/marketplace.json", "POST"), okDb)

    expect(response.status).toBe(405)
    expect(await json(response)).toEqual({ error: "Method Not Allowed" })
    // RFC 9110 requires Allow on a 405.
    expect(response.headers.get("Allow")).toBe("GET")
  })

  test.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"])("%s on a matched path responds 405", async (method) => {
    expect((await handleRequest(request("/marketplace.json", method), okDb)).status).toBe(405)
  })

  test.each(["/marketplaces", "/plugins", "/plugins/search"])("POST %s responds 405, not 404", async (path) => {
    // C-002's and C-003's new paths inherit the router's method check with no per-handler code
    // — and their presence in `routes` is what turns POST into a 405 rather than a 404.
    //
    // /plugins/search carries no `q` here on purpose: the method check runs BEFORE the handler,
    // so a wrong method is a 405 even on a request whose query string would otherwise be a 400.
    const response = await handleRequest(request(path, "POST"), okDb)

    expect(response.status).toBe(405)
    expect(await json(response)).toEqual({ error: "Method Not Allowed" })
    expect(response.headers.get("Allow")).toBe("GET")
  })

  test("path is matched BEFORE method, so POST to an unknown path is 404 not 405", async () => {
    // GAP-004's resolution, and the reason the two checks cannot be reordered.
    const response = await handleRequest(request("/nope", "POST"), okDb)

    expect(response.status).toBe(404)
    expect(await json(response)).toEqual({ error: "Not Found" })
  })
})

describe("router — handler failure (500)", () => {
  let errors: unknown[][]
  let spy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errors = []
    // Silences the deliberate failure's log output, and lets the test assert that the
    // detail was logged rather than discarded.
    spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
  })

  afterEach(() => {
    spy.mockRestore()
  })

  test("a D1 query failure becomes a uniform 500 with the { error } envelope", async () => {
    const response = await handleRequest(request("/marketplace.json"), failingDb)

    expect(response.status).toBe(500)
    expect(await json(response)).toEqual({ error: "Internal Server Error" })
  })

  test.each(["/marketplaces", "/plugins", "/plugins/search?q=x"])(
    "a D1 failure on %s becomes the same uniform 500",
    async (path) => {
      // C-002's and C-003's AC: every endpoint inherits the 5xx envelope from the router's
      // single catch, with no per-handler try/catch (gotcha #8). The handler-level half of this
      // — that the error propagates at all — is asserted in each handler's own test file.
      //
      // `?q=x` is load-bearing: without it the search handler returns its own 400 before
      // `listPlugins` is ever called, and this row would assert nothing about the 500 path.
      const response = await handleRequest(request(path), failingDb)

      expect(response.status).toBe(500)
      expect(await json(response)).toEqual({ error: "Internal Server Error" })
    },
  )

  test("the D1 error's text never reaches the client", async () => {
    // A raw D1 message leaks SQL and schema details. The client gets a fixed string.
    const body = await (await handleRequest(request("/marketplace.json"), failingDb)).text()

    expect(body).not.toContain("D1_ERROR")
    expect(body).not.toContain("SELECT")
    expect(body).not.toContain("plugin")
  })

  test("the failure is logged with the path and the underlying error", async () => {
    await handleRequest(request("/marketplace.json"), failingDb)

    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe("registry request failed")
    expect(errors[0][1]).toBe("/marketplace.json")
    expect(String(errors[0][2])).toContain("D1_ERROR")
  })

  test("a synchronous throw inside a handler is caught too", async () => {
    const throwingDb: RegistryReadDb = {
      async listMarketplaces() {
        return []
      },
      // Not `async`: throws before a promise is ever returned. `await handler(...)` inside
      // the try covers both shapes.
      listPlugins() {
        throw new Error("plugin row: unknown source_type 'archive'")
      },
    }

    const response = await handleRequest(request("/marketplace.json"), throwingDb)

    expect(response.status).toBe(500)
    expect(await json(response)).toEqual({ error: "Internal Server Error" })
  })
})
