import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import path from "path"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
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

// XCOD-320: under an EU-only policy, Recommended and the default come from the published eval results.
describe("ModelCuration EU pick (XCOD-320)", () => {
  const eu = { allow: ["eu"] }
  const fixture = (file: string) =>
    JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", file), "utf8")) as ModelCuration.EvalResult[]

  test("picks the best EU result at 50% or more, never a US, incomplete or global-host one", () => {
    const results = fixture("eval-results-eu.json")
    // The US model scored higher, and Mistral at api.mistral.ai higher still: neither ran in the EU.
    expect(ModelCuration.euPick(results)?.model).toBe("scaleway/qwen3-coder-30b-a3b-instruct")
    expect(ModelCuration.recommended(undefined, eu, results)).toEqual({
      "scaleway/qwen3-coder-30b-a3b-instruct": "Best EU eval: passed 60% of 33 tasks",
    })
    expect(ModelCuration.euDefault(eu, results)).toBe("scaleway/qwen3-coder-30b-a3b-instruct")
    // Exactly 50% is enough.
    const rest = results.filter((result) => !result.model.startsWith("scaleway/"))
    expect(ModelCuration.euPick(rest)?.model).toBe("ovhcloud/qwen3-coder-30b-a3b-instruct")
  })

  test("a Mistral pick says to use its EU endpoint, which an EU-only policy needs", () => {
    const mistral = { ...fixture("eval-results-eu.json")[4], upstreamHosts: ["api.eu.mistral.ai"] }
    expect(ModelCuration.euPick([mistral])?.model).toBe("mistral/devstral-medium-latest")
    expect(ModelCuration.euReason(mistral)).toBe(
      "Best EU eval: passed 95% of 33 tasks; set baseURL to api.eu.mistral.ai",
    )
  })

  test("only a model's latest result counts", () => {
    const results = fixture("eval-results-eu.json")
    const rerun = { ...results[1], date: "2026-12-01", passRate: 0.3 }
    expect(ModelCuration.euPick([...results, rerun])?.model).toBe("ovhcloud/qwen3-coder-30b-a3b-instruct")
  })

  test("no EU model at 50%: Recommended is empty and there's no EU default", () => {
    const results = fixture("eval-results-eu-none.json")
    expect(ModelCuration.euPick(results)).toBeUndefined()
    expect(ModelCuration.recommended(undefined, eu, results)).toEqual({})
    expect(ModelCuration.euDefault(eu, results)).toBeUndefined()
  })

  test("the shipped results have no EU model yet, so EU-only Recommended is empty", () => {
    expect(ModelCuration.recommended(undefined, eu)).toEqual({})
  })

  test("without an EU-only policy, or with an organisation's list, nothing changes", () => {
    const results = fixture("eval-results-eu.json")
    expect(ModelCuration.recommended(undefined, undefined, results)).toBe(ModelCuration.RECOMMENDED)
    expect(ModelCuration.recommended(undefined, { allow: ["eu", "us"] }, results)).toBe(ModelCuration.RECOMMENDED)
    expect(ModelCuration.euDefault({ allow: ["eu", "us"] }, results)).toBeUndefined()
    const org = { "mistral/mistral-small-latest": "Our default" }
    expect(ModelCuration.recommended(org, eu, results)).toBe(org)
    // "unknown" alongside "eu" (a self-hosted model) is still EU-only: US providers stay refused.
    expect(Jurisdiction.euOnly({ allow: ["eu", "unknown"] })).toBe(true)
    expect(Jurisdiction.euOnly({ allow: ["us"] })).toBe(false)
  })

  // The shipped summary must be what specs/eval actually published.
  test("eval-results.json matches the published specs/eval/*.results.json", () => {
    const dir = path.join(import.meta.dir, "../../../../specs/eval")
    const published = readdirSync(dir)
      .filter((file) => file.endsWith(".results.json"))
      .flatMap((file) => {
        const { report } = JSON.parse(readFileSync(path.join(dir, file), "utf8"))
        return (report.models as any[]).map((model) => ({
          model: model.model,
          date: report.date,
          report: `specs/eval/${report.date}.md`,
          status: model.status,
          tasks: model.trials[0]?.total ?? 0,
          ...(model.passRate ? { passRate: model.passRate.mean } : {}),
          ...(model.costPerSolved !== undefined ? { costPerSolved: model.costPerSolved } : {}),
          upstreamHosts: model.upstreamHosts,
        }))
      })
    const key = (result: { model: string; date: string }) => `${result.date} ${result.model}`
    expect([...ModelCuration.published()].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      published.sort((a, b) => key(a).localeCompare(key(b))),
    )
  })
})
