// XCOD-119: what a run is expected to cost, shown before anything is spent.

import type { EvalConfig } from "./config"
import { cost, requirePrices } from "./prices"

export type Line = { model: string; cls: string; runs: number; perTask: number; total: number }

/** What earlier runs already spent under this budget name (runs/ledger-<name>.jsonl), in €. */
export type Spent = { total: number; classes: Record<string, number> }

const NOTHING: Spent = { total: 0, classes: {} }

/**
 * XCOD-320: the projection is checked against what's *left* of each cap, not the cap itself, so a
 * run can't start that the remaining budget can't pay for.
 */
export function estimate(config: EvalConfig, taskCount: number, spent: Spent = NOTHING) {
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
  const left = (cls: string) => (config.budget.classes[cls] ?? 0) - (spent.classes[cls] ?? 0)
  const totalLeft = config.budget.total - spent.total
  const over = Object.entries(byClass)
    .filter(([cls, sum]) => sum > left(cls))
    .map(([cls]) => cls)
  return { lines, byClass, total, spent, totalLeft, fits: total <= totalLeft && over.length === 0, over }
}

export function describe(result: ReturnType<typeof estimate>, config: EvalConfig) {
  const rows = result.lines.map(
    (line) =>
      `  ${line.model.padEnd(36)} ${String(line.runs).padStart(5)} runs × €${line.perTask.toFixed(4)} = €${line.total.toFixed(2)}`,
  )
  const spentNote = (amount: number) => (amount > 0 ? `, €${amount.toFixed(2)} already spent` : "")
  const classes = Object.entries(result.byClass).map(
    ([cls, sum]) =>
      `  ${cls.padEnd(16)} €${sum.toFixed(2)} of €${config.budget.classes[cls]}${spentNote(result.spent.classes[cls] ?? 0)}`,
  )
  return [
    "Estimated cost (the proxy enforces the caps; this is only the expectation):",
    ...rows,
    ...classes,
    `  total            €${result.total.toFixed(2)} of €${config.budget.total}${spentNote(result.spent.total)}`,
    result.fits
      ? "Fits the budget."
      : `Over what's left of the budget${result.over.length ? ` in ${result.over.join(", ")}` : ""}: reduce tasks or trials.`,
  ].join("\n")
}
