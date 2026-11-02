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

describe("pipeline check", () => {
  test("an oracle run names no model result and lists the tasks that failed", () => {
    const report = build({
      config: { ...config, models: [config.models[1]] },
      taskCount: 2,
      results: [result("openai/y", 1, "a", true), result("openai/y", 1, "b", false)],
      ledger: [],
      agent: "oracle",
    })
    expect(report.failed).toEqual(["b"])
    const md = markdown(report)
    expect(md).toContain("pipeline check")
    expect(md).toContain("**Not a model result.**")
    expect(md).toContain("**1 of 2 task runs passed.**")
    expect(md).toContain("- `b`")
    expect(md).not.toContain("openai/y")
    expect(md).not.toContain("All model runs completed")
  })

  test("a model run lists no failed tasks", () => {
    const report = build({ config, taskCount: 1, results: [result("mistral/x", 1, "a", false)], ledger: [] })
    expect(report.failed).toEqual([])
  })
})

describe("patched tasks", () => {
  test("are disclosed in a model report and a pipeline check", () => {
    const input = {
      config,
      taskCount: 1,
      results: [result("mistral/x", 1, "a", true)],
      ledger: [],
      patched: ["polyglot_java_b"],
    }
    expect(markdown(build(input))).toContain("**Changed from the upstream tasks:** in 1 task image (`polyglot_java_b`)")
    expect(markdown(build({ ...input, agent: "oracle" }))).toContain("`polyglot_java_b`")
  })

  test("nothing is said when no task was patched", () => {
    expect(markdown(build({ config, taskCount: 1, results: [], ledger: [] }))).not.toContain(
      "Changed from the upstream",
    )
  })
})

describe("tasks that never got a fair attempt", () => {
  test("a rate-limited or never-started task makes the model INCOMPLETE, with no pass rate", () => {
    const report = build({
      config,
      taskCount: 2,
      results: [
        result("mistral/x", 1, "a", true),
        { ...result("mistral/x", 1, "b", false), error: "ApiRateLimitError" },
        result("mistral/x", 2, "a", true),
        { ...result("mistral/x", 2, "b", false), error: "AgentSetupTimeoutError" },
      ],
      ledger: [],
    })
    const eu = report.models[0]
    expect(eu.status).toBe("incomplete")
    expect(eu.reason).toBe("2 task runs did not run (AgentSetupTimeoutError, ApiRateLimitError)")
    expect(eu.passRate).toBeUndefined()
  })

  test("a task the agent ran and failed still counts as a failure, including code that didn't compile", () => {
    const report = build({
      config,
      taskCount: 1,
      results: [
        { ...result("mistral/x", 1, "a", false), error: "NonZeroAgentExitCodeError" },
        result("mistral/x", 2, "a", true),
      ],
      ledger: [],
    })
    expect(report.models[0].status).toBe("complete")
  })
})
