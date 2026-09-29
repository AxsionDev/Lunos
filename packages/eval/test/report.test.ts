import { describe, expect, test } from "bun:test"
import type { Entry } from "../src/budget"
import type { EvalConfig } from "../src/config"
import { build, markdown, type TaskResult } from "../src/report"

const config = {
  budget: { name: "test", total: 10, classes: { eu: 5, frontier: 5 } },
  usdToEur: { rate: 0.9, date: "2026-09-27" },
  estimate: { inputTokensPerTask: 1, outputTokensPerTask: 1 },
  models: [
    { id: "eu", model: "mistral/x", cls: "eu", upstream: "", keyEnv: "", trials: 2, residency: ["eu"] },
    { id: "fr", model: "openai/y", cls: "frontier", upstream: "", keyEnv: "", trials: 1, residency: ["us"] },
  ],
  prices: {},
  datasets: [],
  lunosVersion: "1.18.40",
  seed: 1,
} satisfies EvalConfig

const result = (model: string, trial: number, task: string, passed: boolean): TaskResult => ({
  model,
  trial,
  task,
  passed,
  seconds: 10,
  toolCalls: 4,
  toolErrors: 1,
})
const entry = (
  model: string,
  cost: number,
  status: Entry["status"] = "settled",
  upstream = "api.mistral.ai",
): Entry => ({
  at: "",
  model,
  cls: "",
  upstream,
  reserved: cost,
  cost,
  status,
})

describe("report", () => {
  test("a complete model gets pass rate with spread, cost per run and per solved task", () => {
    const report = build({
      config,
      taskCount: 2,
      results: [
        result("mistral/x", 1, "a", true),
        result("mistral/x", 1, "b", false),
        result("mistral/x", 2, "a", true),
        result("mistral/x", 2, "b", true),
      ],
      ledger: [entry("mistral/x", 1), entry("mistral/x", 2)],
    })
    const eu = report.models[0]
    expect(eu.status).toBe("complete")
    expect(eu.passRate).toEqual({ mean: 0.75, min: 0.5, max: 1 })
    expect(eu.costPerRun).toBeCloseTo(1.5)
    expect(eu.costPerSolved).toBeCloseTo(1)
    expect(eu.toolErrorRate).toBeCloseTo(0.25)
    expect(eu.upstreamHosts).toEqual(["api.mistral.ai"])
  })

  test("a run cut short by the budget is INCOMPLETE and shows no pass rate", () => {
    const report = build({
      config,
      taskCount: 2,
      results: [result("openai/y", 1, "a", true)],
      ledger: [entry("openai/y", 5, "settled", "api.openai.com"), entry("openai/y", 0, "refused", "api.openai.com")],
    })
    const frontier = report.models[1]
    expect(frontier.status).toBe("incomplete")
    expect(frontier.passRate).toBeUndefined()
    expect(report.complete).toBe(false)
    const md = markdown(report)
    expect(md).toContain("**This report is incomplete.**")
    expect(md).toContain("**INCOMPLETE**: budget cap reached: 1 requests refused")
    expect(md).not.toMatch(/openai\/y`[^\n]*100\.0%/)
  })
})
