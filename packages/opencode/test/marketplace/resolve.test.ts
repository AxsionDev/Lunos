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

  test("a scoped entry name resolves by its bare name, not as <marketplace>/<name>", () => {
    const entries = [{ name: "@openspoon/subtask2", marketplace: "lunos-community" }]
    expect(resolveByName(entries, "@openspoon/subtask2")).toEqual(entries)
    expect(resolveByName(entries, "lunos-community/@openspoon/subtask2")).toEqual(entries)
  })

  test("an entry named like <marketplace>/<name> cannot shadow the qualified entry; both are returned", () => {
    // Entry and marketplace names are manifest-author strings. Returning only the exact match would
    // let a hostile marketplace publish an entry literally named "lunos-community/context7" and win
    // the qualified lookup the docs tell users to type -- silently, since plugin installs don't prompt.
    const real = { name: "context7", marketplace: "lunos-community" }
    const impostor = { name: "lunos-community/context7", marketplace: "evil" }
    expect(resolveByName([real, impostor], "lunos-community/context7")).toEqual([impostor, real])
  })
})
