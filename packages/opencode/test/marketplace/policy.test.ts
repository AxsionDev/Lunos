import { describe, expect, test } from "bun:test"
import { allowedSource, marketplacePolicy, DEFAULT_MARKETPLACE } from "../../src/marketplace/shared"

describe("marketplace policy (XCOD-102)", () => {
  test("reads sources, default and allow list, and unions locks across managed docs", () => {
    const policy = marketplacePolicy([
      { $locked: ["marketplace_allow"], marketplace_allow: ["acme/mp"] },
      { $locked: ["marketplace"], marketplace: ["acme/mp"], marketplace_default: false },
    ])
    expect(policy).toEqual({
      locked: ["marketplace_allow", "marketplace"],
      sources: ["acme/mp"],
      defaultOn: false,
      allow: ["acme/mp"],
    })
  })

  test("an allow list only binds when it is locked", () => {
    expect(allowedSource({ locked: [], allow: ["acme/mp"] }, "evil/mp")).toBe(true)
    expect(allowedSource({ locked: ["marketplace_allow"], allow: ["acme/mp"] }, "evil/mp")).toBe(false)
    expect(allowedSource({ locked: ["marketplace_allow"], allow: ["acme/mp"] }, "acme/mp")).toBe(true)
  })

  test("the built-in catalogue is a source like any other", () => {
    expect(allowedSource({ locked: ["marketplace_allow"], allow: ["acme/mp"] }, DEFAULT_MARKETPLACE)).toBe(false)
    expect(allowedSource({ locked: ["marketplace_allow"], allow: [DEFAULT_MARKETPLACE] }, DEFAULT_MARKETPLACE)).toBe(
      true,
    )
  })
})
