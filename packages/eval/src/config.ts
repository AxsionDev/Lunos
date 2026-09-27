// XCOD-119: the evaluation config (eval.config.json): budget caps, models, prices, task sets.

import type { Price } from "./prices"

export type ModelConfig = {
  /** Proxy route and report label, e.g. "mistral-devstral". */
  id: string
  /** Lunos model, provider/model. */
  model: string
  /** Budget class: its spend counts against budget.classes[cls]. */
  cls: string
  /** OpenAI-compatible endpoint the proxy forwards to. */
  upstream: string
  /** Environment variable on the host that holds the key. Only the proxy reads it. */
  keyEnv: string
  trials: number
  /** Residency policy for this model's runs (XCOD-119 §6). EU models allow only "eu". */
  residency: string[]
}

export type EvalConfig = {
  /**
   * `name` identifies the budget across runs: spend is kept in runs/ledger-<name>.jsonl, and the
   * caps apply to everything spent under that name. All amounts are in €.
   */
  budget: { name: string; total: number; classes: Record<string, number> }
  /** For converting USD list prices into the € prices below by hand; recorded in the report. */
  usdToEur: { rate: number; date: string }
  /** Assumed per-task usage, for the estimate shown before anything runs. */
  estimate: { inputTokensPerTask: number; outputTokensPerTask: number }
  models: ModelConfig[]
  prices: Record<string, Price>
  datasets: { name: string; harbor: string; tasks?: string[] }[]
  /** The Lunos release under test (`lunos-ai@<version>` in each container). */
  lunosVersion: string
  /** Recorded in the report so a run can be identified; Harbor fixes its own task order. */
  seed: number
}

export function validate(config: EvalConfig) {
  const problems: string[] = []
  const classSum = Object.values(config.budget.classes).reduce((a, b) => a + b, 0)
  if (classSum > config.budget.total)
    problems.push(`class caps add up to €${classSum}, more than the total €${config.budget.total}`)
  for (const model of config.models) {
    if (!(model.cls in config.budget.classes)) problems.push(`${model.id}: no budget class "${model.cls}"`)
    if (!(model.trials >= 1)) problems.push(`${model.id}: trials must be at least 1`)
    if (!model.residency.length) problems.push(`${model.id}: needs a residency policy`)
    const price = config.prices[model.model]
    if (price && (!price.source || !/^\d{4}-\d{2}-\d{2}$/.test(price.checked)))
      problems.push(`${model.model}: price needs a source URL and the date it was checked`)
  }
  if (!(config.usdToEur.rate > 0)) problems.push("usdToEur.rate must be set")
  if (!/^[a-z0-9-]+$/.test(config.budget.name ?? ""))
    problems.push("budget.name must be set (lowercase, digits, dashes)")
  if (problems.length) throw new Error(`eval config:\n- ${problems.join("\n- ")}`)
  return config
}
