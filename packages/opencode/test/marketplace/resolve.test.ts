import { describe, expect, test } from "bun:test"
import { resolveByName } from "../../src/marketplace/resolve"

const rows = [
  { name: "filesystem", marketplace: "lunos-community" },
  { name: "filesystem", marketplace: "acme-internal" },
  { name: "searxng", marketplace: "lunos-community" },
]

describe("resolveByName", () => {
  test("finds a uniquely named entry", () => {
    expect(resolveByName(rows, "searxng")).toEqual([{ name: "searxng", marketplace: "lunos-community" }])
  })

  test("returns nothing for a name no marketplace carries", () => {
    expect(resolveByName(rows, "nope")).toEqual([])
  })

  test("returns every match when two marketplaces use the same name", () => {
    // The caller must disambiguate. Silently preferring whichever marketplace was added
    // first is how a user installs something they did not intend.
    expect(resolveByName(rows, "filesystem")).toHaveLength(2)
  })

  test("selects one entry when the name is qualified with its marketplace", () => {
    expect(resolveByName(rows, "acme-internal/filesystem")).toEqual([
      { name: "filesystem", marketplace: "acme-internal" },
    ])
  })
})
