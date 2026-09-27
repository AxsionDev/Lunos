// XCOD-119: turns Harbor trial results and the proxy ledger into the published report
// (JSON + specs/eval/<date>.md). A model whose runs didn't all finish, or hit a budget cap, is
// reported as INCOMPLETE and its pass rate is never shown as a result.

import type { EvalConfig } from "./config"
import type { Entry } from "./budget"

export type TaskResult = {
  model: string
  trial: number
  task: string
  passed: boolean
  seconds: number
  toolCalls: number
  toolErrors: number
  error?: string
}

export type ModelReport = {
  model: string
  cls: string
  residency: string[]
  status: "complete" | "incomplete"
  reason?: string
  trials: { trial: number; passed: number; total: number; rate: number }[]
  passRate?: { mean: number; min: number; max: number }
  spend: number
  costPerRun?: number
  costPerSolved?: number
  medianSeconds?: number
  toolErrorRate?: number
  upstreamHosts: string[]
  refusedRequests: number
}

function median(values: number[]) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function build(input: { config: EvalConfig; taskCount: number; results: TaskResult[]; ledger: Entry[] }) {
  const models: ModelReport[] = input.config.models.map((model) => {
    const results = input.results.filter((result) => result.model === model.model)
    const entries = input.ledger.filter((entry) => entry.model === model.model)
    const refused = entries.filter((entry) => entry.status === "refused").length
    const spend = entries.reduce((sum, entry) => sum + entry.cost, 0)
    const trials = Array.from({ length: model.trials }, (_, i) => {
      const runs = results.filter((result) => result.trial === i + 1)
      const passed = runs.filter((result) => result.passed).length
      return { trial: i + 1, passed, total: runs.length, rate: runs.length ? passed / runs.length : 0 }
    })
    const missing = trials.some((trial) => trial.total < input.taskCount)
    const status = missing || refused > 0 ? "incomplete" : "complete"
    const reason =
      refused > 0
        ? `budget cap reached: ${refused} requests refused`
        : missing
          ? "not every task ran in every trial"
          : undefined
    const base = {
      model: model.model,
      cls: model.cls,
      residency: model.residency,
      status,
      reason,
      trials,
      spend,
      upstreamHosts: [...new Set(entries.map((entry) => entry.upstream))].sort(),
      refusedRequests: refused,
    } satisfies ModelReport
    if (status === "incomplete") return base
    const rates = trials.map((trial) => trial.rate)
    const solved = results.filter((result) => result.passed).length
    const calls = results.reduce((sum, result) => sum + result.toolCalls, 0)
    return {
      ...base,
      passRate: {
        mean: rates.reduce((a, b) => a + b, 0) / rates.length,
        min: Math.min(...rates),
        max: Math.max(...rates),
      },
      costPerRun: spend / model.trials,
      costPerSolved: solved ? spend / solved : undefined,
      medianSeconds: median(results.map((result) => result.seconds)),
      toolErrorRate: calls ? results.reduce((sum, result) => sum + result.toolErrors, 0) / calls : 0,
    }
  })
  return {
    date: new Date().toISOString().slice(0, 10),
    lunosVersion: input.config.lunosVersion,
    seed: input.config.seed,
    usdToEur: input.config.usdToEur,
    budget: input.config.budget,
    totalSpend: models.reduce((sum, model) => sum + model.spend, 0),
    complete: models.every((model) => model.status === "complete"),
    models,
  }
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const eur = (value: number | undefined) => (value === undefined ? "–" : `€${value.toFixed(2)}`)

export function markdown(report: ReturnType<typeof build>) {
  const lines = [
    `# Lunos evaluation, ${report.date}`,
    "",
    report.complete
      ? "All model runs completed."
      : "> [!WARNING]\n> **This report is incomplete.** Models marked INCOMPLETE did not finish every task in every trial, or hit a budget cap. Their pass rates are not shown, because a partial run's rate is not comparable.",
    "",
    `Lunos ${report.lunosVersion}, run seed ${report.seed}. Spend €${report.totalSpend.toFixed(2)} of the €${report.budget.total} "${report.budget.name}" budget, metered by the harness's proxy at its own € prices (USD list prices converted at ${report.usdToEur.rate}, ${report.usdToEur.date}).`,
    "",
    "**Method:** pass@1, one attempt per task with no test feedback; the grading tests are hidden from the agent and copied in only to grade. Lunos runs with `LUNOS_OFFLINE=1`: no web tools, and only LSP servers and formatters already in the image. These numbers measure Lunos's own agent and are not comparable with Aider's leaderboard, which uses Aider's harness and protocol.",
    "",
    "| Model | Class | Residency | Pass rate (mean, min–max) | Cost / run | Cost / solved | Median time | Tool error rate | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.models.map((model) =>
      [
        `\`${model.model}\``,
        model.cls,
        model.residency.join(", "),
        model.passRate ? `${pct(model.passRate.mean)} (${pct(model.passRate.min)}–${pct(model.passRate.max)})` : "–",
        eur(model.costPerRun),
        eur(model.costPerSolved),
        model.medianSeconds === undefined ? "–" : `${Math.round(model.medianSeconds)} s`,
        model.toolErrorRate === undefined ? "–" : pct(model.toolErrorRate),
        model.status === "complete" ? "complete" : `**INCOMPLETE**: ${model.reason}`,
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .concat(" |"),
    ),
    "",
    "## Where the traffic went",
    "",
    "Every model request went through the harness's metering proxy. These are the upstream hosts it forwarded to, per model:",
    "",
    ...report.models.map(
      (model) =>
        `- \`${model.model}\` (${model.residency.join(", ")}): ${model.upstreamHosts.map((host) => `\`${host}\``).join(", ") || "none"}`,
    ),
  ]
  return lines.join("\n") + "\n"
}
