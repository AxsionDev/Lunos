import { describe, expect, test } from "bun:test"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { ProviderPlugins } from "@opencode-ai/core/plugin/provider"

describe("Jurisdiction", () => {
  // This is the test that makes XCOD-61's "populated for all providers" acceptance criterion
  // verifiable rather than a claim. It also fails loudly when someone adds a 35th provider
  // plugin without recording where it processes data — which is the failure mode that would
  // quietly erode the residency guarantees XCOD-62 builds on top of this table.
  test("every provider plugin has a recorded jurisdiction claim", () => {
    const ids = ProviderPlugins.map((plugin) => plugin.id)

    // Without this, an empty or failed-to-import `ProviderPlugins` would make the assertion
    // below pass vacuously — the test would go green precisely when it had stopped checking
    // anything. 30 is a floor, not the exact count, so adding a provider doesn't fail here.
    expect(ids.length).toBeGreaterThan(30)

    expect(ids.filter((id) => !Jurisdiction.isTagged(id))).toEqual([])
  })

  test("covers the EU providers reachable through the generic openai-compatible plugin", () => {
    // These have no plugin of their own — they are catalog entries dispatched via
    // `openai-compatible`. A plugin-keyed table would miss exactly the providers this
    // story exists to make selectable, so they are asserted explicitly.
    for (const id of ["scaleway", "ovhcloud", "hetzner"]) {
      expect(Jurisdiction.isTagged(id)).toBe(true)
      expect(Jurisdiction.lookup(id).region).toBe("eu")
    }
  })

  describe("unknown providers", () => {
    test("are not assumed safe", () => {
      const claim = Jurisdiction.lookup("some-provider-that-does-not-exist")

      expect(claim.region).toBe("unknown")
      expect(claim.basis).toBe("none")
      expect(Jurisdiction.isEuByDefault("some-provider-that-does-not-exist")).toBe(false)
    })
  })

  describe("isEuByDefault", () => {
    test("is true only when the provider is EU without configuration", () => {
      expect(Jurisdiction.isEuByDefault("mistral")).toBe(true)
      expect(Jurisdiction.isEuByDefault("scaleway")).toBe(true)
      expect(Jurisdiction.isEuByDefault("anthropic")).toBe(false)
    })

    // The load-bearing case. Azure *can* be EU, but nothing here can verify that a given
    // deployment pointed it at an EU region. Reporting it as EU would let a US-region Azure
    // resource pass a policy that claims to block one, so `configurable` must fail closed.
    test("treats configurable providers as not-EU", () => {
      for (const id of ["azure", "amazon-bedrock", "google-vertex", "sap-ai-core"]) {
        expect(Jurisdiction.lookup(id).region).toBe("configurable")
        expect(Jurisdiction.isEuByDefault(id)).toBe(false)
      }
    })
  })

  describe("claim discipline", () => {
    // Per XCOD-55's wording rules: an unqualified EU claim requires both an EU entity and EU
    // processing. Anything resting on only one of those must say which one.
    test("only `both` backs an unqualified eu region", () => {
      for (const id of Jurisdiction.euProviders()) {
        expect(Jurisdiction.lookup(id).basis).toBe("both")
      }
    })

    test("every configurable provider explains how to actually get the EU", () => {
      const configurable = Jurisdiction.taggedProviders().filter(
        (id) => Jurisdiction.lookup(id).region === "configurable",
      )
      expect(configurable.length).toBeGreaterThan(0)

      for (const id of configurable) {
        // A `configurable` tag without instructions is not actionable for a deployer.
        expect(Jurisdiction.lookup(id).euOption).toBeTruthy()
      }
    })

    test("every claim carries a note", () => {
      for (const id of Jurisdiction.taggedProviders()) {
        expect(Jurisdiction.lookup(id).note.length).toBeGreaterThan(0)
      }
    })

    // Gateways cannot have a jurisdiction of their own: they inherit whatever they route to.
    // Asserting a region for one would be an overclaim by construction.
    test("gateways assert no region of their own", () => {
      for (const id of ["openrouter", "gateway", "llmgateway", "cloudflare-ai-gateway"]) {
        const claim = Jurisdiction.lookup(id)
        expect(claim.basis).toBe("gateway")
        expect(claim.region).toBe("unknown")
      }
    })
  })
})
