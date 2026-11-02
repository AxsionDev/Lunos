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

/**
 * Harbor exceptions that mean the task never got a fair attempt: the provider refused the request,
 * or Lunos never started. Counted as "did not run", never as a model failure. Not
 * RewardFileNotFoundError: the Polyglot C++ tests exit without a reward when the agent's code
 * doesn't compile, which is the agent's failure (the oracle check compiles every task).
 */
export const DID_NOT_RUN = new Set([
  "ApiRateLimitError",
  "AgentSetupTimeoutError",
  "EnvironmentStartTimeoutError",
  "DockerBuildError",
])

function median(values: number[]) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function build(input: {
  config: EvalConfig
  taskCount: number
  results: TaskResult[]
  ledger: Entry[]
  /** A built-in Harbor agent ran instead of Lunos, e.g. "oracle": a pipeline check, not a result. */
  agent?: string
  /** Tasks whose Dockerfile the harness patched (stage.ts). Disclosed, since it changes the benchmark. */
  patched?: string[]
}) {
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
    const notRun = results.filter((result) => result.error && DID_NOT_RUN.has(result.error))
    const status = missing || refused > 0 || notRun.length > 0 ? "incomplete" : "complete"
    const reason =
      refused > 0
        ? `budget cap reached: ${refused} requests refused`
        : missing
          ? "not every task ran in every trial"
          : notRun.length > 0
            ? `${notRun.length} task runs did not run (${[...new Set(notRun.map((result) => result.error))].sort().join(", ")})`
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
    agent: input.agent,
    patched: [...(input.patched ?? [])].sort(),
    /** Under the oracle every task should pass; one that doesn't is broken, not a model result. */
    failed: input.agent
      ? [...new Set(input.results.filter((result) => !result.passed).map((result) => result.task))].sort()
      : [],
    models,
  }
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const eur = (value: number | undefined) => (value === undefined ? "–" : `€${value.toFixed(2)}`)

export function markdown(report: ReturnType<typeof build>) {
  if (report.agent) return pipelineCheck(report)
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
    ...patchNote(report),
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

function patchNote(report: ReturnType<typeof build>) {
  if (!report.patched.length) return []
  return [
    `**Changed from the upstream tasks:** in ${report.patched.length} task image${report.patched.length === 1 ? "" : "s"} (${report.patched.map((task) => `\`${task}\``).join(", ")}), \`JAVA_HOME\` points at the JDK for the host's architecture instead of the hard-coded amd64 path, which doesn't exist on arm64. The tasks and their tests are unchanged.`,
    "",
  ]
}

/** A run with a built-in Harbor agent: no model was called, so no model is named as a result. */
function pipelineCheck(report: ReturnType<typeof build>) {
  const trials = report.models.flatMap((model) => model.trials)
  const passed = trials.reduce((sum, trial) => sum + trial.passed, 0)
  const total = trials.reduce((sum, trial) => sum + trial.total, 0)
  const lines = [
    `# Lunos evaluation pipeline check, ${report.date}`,
    "",
    `> [!CAUTION]\n> **Not a model result.** Harbor's \`${report.agent}\` agent ran instead of Lunos: no model was called. Every task should pass; a task that fails here is broken and must be excluded from the paid run.`,
    "",
    `Lunos ${report.lunosVersion}, run seed ${report.seed}. **${passed} of ${total} task runs passed.** Spend €${report.totalSpend.toFixed(2)}.`,
    "",
    ...patchNote(report),
  ]
  if (report.failed.length) lines.push("", "## Tasks that failed", "", ...report.failed.map((task) => `- \`${task}\``))
  return lines.join("\n") + "\n"
}
