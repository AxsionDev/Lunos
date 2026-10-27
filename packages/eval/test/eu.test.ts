import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
// Relative: the eval package doesn't depend on core.
import { Jurisdiction } from "../../core/src/jurisdiction"
import { Ledger } from "../src/budget"
import { validate, type EvalConfig } from "../src/config"
import { describe as describeEstimate, estimate } from "../src/estimate"
import { lunosConfig } from "../src/job"

// XCOD-320: the EU campaign (eval.eu.json): Mistral at its EU endpoint and STACKIT, €60 in total.
const load = async () => (await Bun.file(path.join(import.meta.dir, "../eval.eu.json")).json()) as EvalConfig

describe("EU campaign config", () => {
  test("validates, caps the total at €60 with a budget per model, and sends traffic only to EU hosts", async () => {
    const config = validate(await load())
    expect(config.budget.total).toBe(60)
    expect(new Set(config.models.map((model) => model.cls)).size).toBe(config.models.length)
    for (const model of config.models) {
      expect(config.budget.classes[model.cls]).toBeGreaterThan(0)
      expect(model.residency).toEqual(["eu"])
      // The proxy's upstream log is the residency evidence, so the upstream itself must be EU.
      const claim = Jurisdiction.resolve(model.model.split("/")[0], model.upstream, undefined).claim
      expect([model.id, claim.region]).toEqual([model.id, "eu"])
    }
    expect(config.models.some((model) => model.upstream.includes("api.mistral.ai"))).toBe(false)
  })

  test("the 33-task estimate fits the cap", async () => {
    const result = estimate(await load(), 33)
    expect(result.fits).toBe(true)
    expect(result.total).toBeLessThan(60)
  })

  test("a STACKIT model id keeps its own slash in the Lunos config", async () => {
    const model = (await load()).models.find((item) => item.model === "stackit/Qwen/Qwen3.8-27B")!
    const lunos = lunosConfig(model, "http://proxy", "/logs/audit.log")
    expect(lunos.model).toBe("stackit/Qwen/Qwen3.8-27B")
    expect(Object.keys(lunos.provider.stackit.models)).toEqual(["Qwen/Qwen3.8-27B"])
    // STACKIT caps generation below Lunos's 32000 default; the limit has to reach Lunos's config.
    expect(lunos.provider.stackit.models["Qwen/Qwen3.8-27B"]).toMatchObject({ limit: { output: 16384 } })
    for (const item of (await load()).models.filter((m) => m.model.startsWith("stackit/"))) {
      const price = (await load()).prices[item.model]
      expect(item.limit?.output).toBe(price.kind === "api" ? price.maxOutputTokens : -1)
    }
    expect(lunos.residency.endpoints.stackit).toEqual({
      region: "eu",
      note: "Lunos eval metering proxy, forwarding to api.openai-compat.model-serving.eu01.onstackit.cloud",
    })
  })
})

describe("remaining budget", () => {
  test("a run whose projection passes what's left of a cap is refused before it starts", async () => {
    const config = await load()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-ledger-"))
    const file = path.join(dir, "ledger-eu-2026-11.jsonl")
    const fresh = estimate(config, 33, new Ledger(config.budget, file).spentSoFar())
    expect(fresh.fits).toBe(true)

    // An earlier run under the same budget name spent almost all of one model's class.
    const cls = config.models[0].cls
    const entry = {
      at: "2026-11-01T00:00:00Z",
      model: config.models[0].model,
      cls,
      upstream: "api.eu.mistral.ai",
      reserved: 1,
      cost: config.budget.classes[cls] - 0.01,
      status: "settled",
    }
    await Bun.write(file, JSON.stringify(entry) + "\n")
    const after = estimate(config, 33, new Ledger(config.budget, file).spentSoFar())
    expect(after.fits).toBe(false)
    expect(after.over).toEqual([cls])
    expect(describeEstimate(after, config)).toContain("already spent")

    // And the total: €59.50 already spent leaves less than the projection, whatever the classes say.
    expect(estimate(config, 33, { total: config.budget.total - 0.5, classes: {} }).fits).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
