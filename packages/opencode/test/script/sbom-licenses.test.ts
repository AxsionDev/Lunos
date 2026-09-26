import { describe, expect, test } from "bun:test"
import { key, toCycloneDx } from "../../../../script/sbom-licenses"

describe("SBOM licences (XCOD-108)", () => {
  test("single SPDX ids, expressions and legacy strings map to the right CycloneDX shape", () => {
    expect(toCycloneDx("MIT")).toEqual([{ license: { id: "MIT" } }])
    expect(toCycloneDx("(MIT OR Apache-2.0)")).toEqual([{ expression: "(MIT OR Apache-2.0)" }])
    expect(toCycloneDx("SEE LICENSE IN LICENSE")).toEqual([{ license: { name: "SEE LICENSE IN LICENSE" } }])
    expect(toCycloneDx([{ type: "MIT" }, { type: "BSD-3-Clause" }])).toEqual([
      { expression: "(MIT) OR (BSD-3-Clause)" },
    ])
    expect(toCycloneDx(undefined)).toBeUndefined()
  })

  test("components are keyed by their npm purl, scoped names decoded", () => {
    expect(key({ purl: "pkg:npm/%40actions/core@1.11.1" })).toBe("@actions/core@1.11.1")
    expect(key({ purl: "pkg:npm/7zip-bin@5.2.0" })).toBe("7zip-bin@5.2.0")
    expect(key({ name: "x", group: "@a", version: "1" })).toBe("@a/x@1")
  })
})
