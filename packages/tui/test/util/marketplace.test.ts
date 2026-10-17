import { describe, expect, test } from "bun:test"
import { parseMarketplaceSlash, requestDiscover, takeDiscoverRequest } from "../../src/util/marketplace"

describe("/marketplace (XCOD-251)", () => {
  test("bare /marketplace and /discover open the Plugins tab", () => {
    expect(parseMarketplaceSlash("/marketplace")).toEqual({})
    expect(parseMarketplaceSlash("  /discover  ")).toEqual({})
  })

  test("a tab name opens that tab, singular or plural, any case", () => {
    expect(parseMarketplaceSlash("/marketplace mcp")).toEqual({ kind: "mcp" })
    expect(parseMarketplaceSlash("/marketplace skills")).toEqual({ kind: "skill" })
    expect(parseMarketplaceSlash("/marketplace Hooks")).toEqual({ kind: "hook" })
    expect(parseMarketplaceSlash("/discover plugin")).toEqual({ kind: "plugin" })
  })

  test("installed lists what's installed; anything else is a search", () => {
    expect(parseMarketplaceSlash("/marketplace installed")).toEqual({ installed: true })
    expect(parseMarketplaceSlash("/marketplace playwright")).toEqual({ search: "playwright" })
    expect(parseMarketplaceSlash("/marketplace  browser tests ")).toEqual({ search: "browser tests" })
  })

  test("other text isn't ours", () => {
    expect(parseMarketplaceSlash("/marketplaces")).toBeUndefined()
    expect(parseMarketplaceSlash("open the /marketplace")).toBeUndefined()
    expect(parseMarketplaceSlash("/plugins")).toBeUndefined()
  })

  test("the request is taken once; an open without one gets the default", () => {
    requestDiscover({ kind: "mcp" })
    expect(takeDiscoverRequest()).toEqual({ kind: "mcp" })
    expect(takeDiscoverRequest()).toEqual({})
  })
})
