// XCOD-119: what a run is expected to cost, shown before anything is spent.

import type { EvalConfig } from "./config"
import { cost, requirePrices } from "./prices"

export type Line = { model: string; cls: string; runs: number; perTask: number; total: number }

export function estimate(config: EvalConfig, taskCount: number) {
  requirePrices(
    config.models.map((model) => model.model),
    config.prices,
  )
  const lines: Line[] = config.models.map((model) => {
    const price = config.prices[model.model]
    if (price.kind === "gpu")
      throw new Error(`${model.model}: GPU-hour budgeting is set per run, not estimated per task`)
    const perTask = cost(price, {
      input: config.estimate.inputTokensPerTask,
      output: config.estimate.outputTokensPerTask,
    })
    const runs = taskCount * model.trials
    return { model: model.model, cls: model.cls, runs, perTask, total: perTask * runs }
  })
  const byClass: Record<string, number> = {}
  for (const line of lines) byClass[line.cls] = (byClass[line.cls] ?? 0) + line.total
  const total = lines.reduce((sum, line) => sum + line.total, 0)
  const over = Object.entries(byClass)
    .filter(([cls, sum]) => sum > (config.budget.classes[cls] ?? 0))
    .map(([cls]) => cls)
  return { lines, byClass, total, fits: total <= config.budget.total && over.length === 0, over }
}

export function describe(result: ReturnType<typeof estimate>, config: EvalConfig) {
  const rows = result.lines.map(
    (line) =>
      `  ${line.model.padEnd(36)} ${String(line.runs).padStart(5)} runs × €${line.perTask.toFixed(4)} = €${line.total.toFixed(2)}`,
  )
  const classes = Object.entries(result.byClass).map(
    ([cls, sum]) => `  ${cls.padEnd(16)} €${sum.toFixed(2)} of €${config.budget.classes[cls]}`,
  )
  return [
    "Estimated cost (the proxy enforces the caps; this is only the expectation):",
    ...rows,
    ...classes,
    `  total            €${result.total.toFixed(2)} of €${config.budget.total}`,
    result.fits
      ? "Fits the budget."
      : `Over budget${result.over.length ? ` in ${result.over.join(", ")}` : ""}: reduce tasks or trials.`,
  ].join("\n")
}
