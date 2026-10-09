import { describe, expect, test } from "bun:test"
import { ModelCuration } from "../../src/provider/curation"

describe("ModelCuration.size (XCOD-213)", () => {
  test("open-weight and local models go by total parameters in the id", () => {
    expect(ModelCuration.size("ollama", "qwen3:4b")).toBe("small")
    expect(ModelCuration.size("ovhcloud", "qwen3.5-9b")).toBe("small")
    expect(ModelCuration.size("ovhcloud", "gpt-oss-20b")).toBe("medium")
    expect(ModelCuration.size("scaleway", "llama-3.3-70b-instruct")).toBe("large")
    // Mixture of experts: total, not active ("a17b") parameters.
    expect(ModelCuration.parameters("qwen3.5-397b-a17b")).toBe(397)
    expect(ModelCuration.parameters("open-mixtral-8x22b")).toBe(176)
    expect(ModelCuration.size("scaleway", "qwen3-coder-30b-a3b-instruct")).toBe("medium")
  })

  test("hosted models go by the provider's own tier, EU and US alike", () => {
    expect(ModelCuration.size("mistral", "mistral-large-latest")).toBe("large")
    expect(ModelCuration.size("mistral", "mistral-small-latest")).toBe("small")
    expect(ModelCuration.size("mistral", "ministral-8b-latest")).toBe("small")
    expect(ModelCuration.size("anthropic", "claude-haiku-4-5")).toBe("small")
    expect(ModelCuration.size("anthropic", "claude-opus-5-5")).toBe("large")
    expect(ModelCuration.size("anthropic", "claude-sonnet-4-5-20250929")).toBe("large")
    expect(ModelCuration.size("openai", "gpt-5-mini")).toBe("small")
    expect(ModelCuration.size("google", "gemini-2.5-flash-lite")).toBe("small")
    expect(ModelCuration.size("google", "gemini-2.5-pro")).toBe("large")
  })

  test("unknown sizes and non-chat models get no tag rather than a guess", () => {
    expect(ModelCuration.size("openai", "gpt-5.5")).toBeUndefined()
    expect(ModelCuration.size("mistral", "codestral-latest")).toBeUndefined()
    expect(ModelCuration.size("mistral", "mistral-embed")).toBeUndefined()
    expect(ModelCuration.size("mistral", "voxtral-mini-latest")).toBeUndefined()
    expect(ModelCuration.size("nebius", "moonshotai/Kimi-K3")).toBeUndefined()
  })
})

describe("ModelCuration.recommended (XCOD-213)", () => {
  test("every built-in entry has a short reason and no benchmark wording", () => {
    for (const [spec, why] of Object.entries(ModelCuration.RECOMMENDED)) {
      expect(spec).toMatch(/^[^/]+\/.+/)
      expect(why.length).toBeLessThanOrEqual(52)
      expect(why).not.toMatch(/evaluat|benchmark/i)
    }
  })

  test("an organisation's list replaces the built-in one", () => {
    const org = { "mistral/mistral-small-latest": "Our default" }
    expect(ModelCuration.recommended(org)).toEqual(org)
    expect(ModelCuration.recommended(undefined)).toBe(ModelCuration.RECOMMENDED)
  })
})
