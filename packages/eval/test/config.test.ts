import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { harborResults, toolStats } from "../src/cli"
import { validate, type EvalConfig } from "../src/config"
import { estimate } from "../src/estimate"
import { harborJob, lunosConfig } from "../src/job"

const config = (): EvalConfig => ({
  lunosVersion: "1.18.40",
  seed: 1,
  budget: { total: 100, classes: { "eu-api": 45, frontier: 45 } },
  usdToEur: { rate: 0.9, date: "2026-09-27" },
  estimate: { inputTokensPerTask: 60_000, outputTokensPerTask: 6_000 },
  models: [
    {
      id: "mistral",
      model: "mistral/devstral",
      cls: "eu-api",
      upstream: "https://api.mistral.ai/v1",
      keyEnv: "MISTRAL_API_KEY",
      trials: 3,
      residency: ["eu"],
    },
  ],
  prices: {
    "mistral/devstral": {
      kind: "api",
      input: 0.4,
      output: 2,
      maxOutputTokens: 32000,
      source: "https://mistral.ai/pricing",
      checked: "2026-09-27",
    },
  },
  datasets: [{ name: "lunos", harbor: "./packages/eval/tasks" }],
})

describe("config", () => {
  test("class caps can't add up to more than the total", () => {
    const bad = config()
    bad.budget.classes.frontier = 60
    expect(() => validate(bad)).toThrow("more than the total")
  })

  test("a price needs its source and the date it was checked", () => {
    const bad = config()
    bad.prices["mistral/devstral"] = { ...(bad.prices["mistral/devstral"] as any), checked: "" }
    expect(() => validate(bad)).toThrow("source URL and the date it was checked")
  })

  test("the example config is refused until real prices and a rate are filled in", async () => {
    const example = await Bun.file(path.join(import.meta.dir, "../eval.config.example.json")).json()
    expect(() => validate(example)).toThrow("usdToEur.rate")
    expect(() => estimate({ ...example, usdToEur: { rate: 0.9, date: "2026-09-27" } }, 3)).toThrow("No price for")
  })
})

describe("estimate", () => {
  test("tasks × trials × assumed usage, checked against each class cap", () => {
    const result = estimate(config(), 100)
    const perTask = (60_000 * 0.4 + 6_000 * 2) / 1e6
    expect(result.lines[0]).toMatchObject({ runs: 300 })
    expect(result.total).toBeCloseTo(perTask * 300)
    expect(result.fits).toBe(true)
    expect(estimate(config(), 5000).over).toEqual(["eu-api"])
  })
})

describe("harbor job", () => {
  test("points the provider at the proxy, with a dummy key and the model's residency policy", () => {
    const lunos = lunosConfig(config().models[0], "http://host.docker.internal:9000", "/logs/audit.log")
    expect(lunos.provider.mistral.options).toEqual({
      baseURL: "http://host.docker.internal:9000/mistral/v1",
      apiKey: "via-lunos-eval-proxy",
    })
    expect(lunos.residency).toEqual({ allow: ["eu"], audit: true, auditPath: "/logs/audit.log" })
    expect(lunos.enabled_providers).toEqual(["mistral"])
    expect(JSON.stringify(lunos)).not.toContain("sk-")
  })

  test("uses the Lunos agent adapter at the configured version", () => {
    const job = harborJob({
      config: config(),
      model: config().models[0],
      trial: 2,
      proxyURL: "http://p",
      jobsDir: "/j",
      concurrency: 2,
    })
    expect(job.job_name).toBe("mistral-t2")
    expect(job.agents[0]).toMatchObject({
      import_path: "lunos_agent:Lunos",
      model_name: "mistral/devstral",
      kwargs: { version: "1.18.40" },
    })
    expect(job.datasets).toEqual([{ path: "./packages/eval/tasks", task_names: undefined }])
  })
})

describe("harbor results", () => {
  test("reads pass/fail, time and tool errors from Harbor's trial directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harbor-"))
    const trial = path.join(dir, "xcod-111__abc")
    await fs.mkdir(path.join(trial, "agent"), { recursive: true })
    await Bun.write(
      path.join(trial, "result.json"),
      JSON.stringify({
        task_name: "lunos/xcod-111",
        verifier_result: { rewards: { reward: 1 } },
        agent_execution: { started_at: "2026-09-27T10:00:00Z", finished_at: "2026-09-27T10:01:30Z" },
      }),
    )
    await Bun.write(
      path.join(trial, "agent", "opencode.txt"),
      [
        '{"type":"tool_use","part":{"state":{"status":"completed"}}}',
        '{"type":"tool_use","part":{"state":{"status":"error"}}}',
        "not json",
      ].join("\n"),
    )
    const results = await harborResults(dir, "mistral/devstral", 1)
    expect(results).toEqual([
      {
        model: "mistral/devstral",
        trial: 1,
        task: "lunos/xcod-111",
        passed: true,
        seconds: 90,
        toolCalls: 2,
        toolErrors: 1,
        error: undefined,
      },
    ])
    expect(toolStats("")).toEqual({ calls: 0, errors: 0 })
  })
})
