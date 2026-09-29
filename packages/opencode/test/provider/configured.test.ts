import { describe, expect, test } from "bun:test"
import { ProviderConfigured } from "../../src/provider/configured"

const NOW = 1_000_000

describe("ProviderConfigured.list (XCOD-130)", () => {
  test("lists stored credentials and env/config providers with method, status and jurisdiction", () => {
    const items = ProviderConfigured.list({
      now: NOW,
      credentials: {
        mistral: { type: "api" },
        anthropic: { type: "oauth", refresh: "r", expires: NOW - 1 },
        gone: { type: "api" },
      },
      loaded: {
        mistral: { name: "Mistral", source: "api", options: {} },
        anthropic: { name: "Anthropic", source: "api", options: {} },
        openai: { name: "OpenAI", source: "env", options: {} },
      },
      names: { gone: "Gone Provider" },
    })
    expect(items.map((item) => [item.id, item.method, item.status, item.stored, item.jurisdiction.region])).toEqual([
      ["anthropic", "oauth", "connected", true, "us"],
      ["gone", "api", "error", true, "unknown"],
      ["mistral", "api", "connected", true, "eu"],
      ["openai", "env", "connected", false, "us"],
    ])
  })

  test("an OAuth credential is expired only when it can't be refreshed", () => {
    expect(ProviderConfigured.status({ type: "oauth", refresh: "", expires: NOW - 1 }, true, NOW)).toBe("expired")
    expect(ProviderConfigured.status({ type: "oauth", refresh: "r", expires: NOW - 1 }, true, NOW)).toBe("connected")
    expect(ProviderConfigured.status({ type: "oauth", refresh: "", expires: NOW + 1 }, true, NOW)).toBe("connected")
  })

  test("uses the endpoint, not just the id, for jurisdiction (XCOD-138)", () => {
    const [item] = ProviderConfigured.list({
      now: NOW,
      credentials: {},
      loaded: { mistral: { name: "Mistral", source: "config", options: { baseURL: "http://localhost:9000/v1" } } },
      names: {},
    })
    expect(item?.jurisdiction).toEqual({ region: "unknown", basis: "user-endpoint" })
  })

  test("never carries secrets", () => {
    const items = ProviderConfigured.list({
      now: NOW,
      credentials: { anthropic: { type: "api", key: "sk-secret" } as never },
      loaded: {},
      names: {},
    })
    expect(JSON.stringify(items)).not.toContain("sk-secret")
  })
})
