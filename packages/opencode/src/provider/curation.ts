export * as ModelCuration from "./curation"

import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import shipped from "./eval-results.json" with { type: "json" }

/**
 * Model size tags and the "Recommended" list (XCOD-213).
 *
 * Without a residency policy, "Recommended" is a curated choice maintained by Lunos and shipped
 * with each release, not an evaluation or a benchmark. Under an EU-only policy (XCOD-320) it is
 * data-driven instead: the best EU model in the published eval results (`eval-results.json`, from
 * specs/eval/), if it passed at least half the tasks, and nothing otherwise.
 */

export type Size = "large" | "medium" | "small"

/** Parameter-count thresholds, in billions of total parameters (MoE: total, not active). */
export const SMALL_MAX_B = 15
export const LARGE_MIN_B = 70

/**
 * Curated defaults, "provider/model" → why. EU-hosted and local models only, to match the
 * residency defaults Lunos is built around (Mistral's only at its EU endpoint, XCOD-194). Reasons stay under ~50 characters so they fit the
 * TUI picker's detail line. An organisation replaces this list with the
 * `recommended` config key (lockable with `$locked`).
 */
export const RECOMMENDED: Readonly<Record<string, string>> = {
  "mistral/mistral-medium-latest": "EU at api.eu.mistral.ai; balanced coding default",
  "mistral/mistral-large-latest": "EU at api.eu.mistral.ai; flagship, hard reasoning",
  "mistral/codestral-latest": "EU at api.eu.mistral.ai; fast completion, edits",
  "mistral/mistral-small-latest": "EU at api.eu.mistral.ai; cheap, fast, simple",
  "scaleway/qwen3-coder-30b-a3b-instruct": "EU-hosted (Scaleway, France); open-weight coder",
  "ovhcloud/qwen3-coder-30b-a3b-instruct": "EU-hosted (OVHcloud); open-weight coding model",
  "ollama/qwen3:4b": "Runs on your machine, offline; for simple edits",
}

/**
 * Hosted models whose name says nothing reliable about their size: provider, id pattern, size.
 * Only where the provider's own tiering is clear; anything else stays untagged.
 */
const OVERRIDES: ReadonlyArray<readonly [string, RegExp, Size]> = [
  ["anthropic", /^claude-sonnet-/, "large"],
  ["openai", /^o[13](?:-\d|$)/, "large"],
  ["mistral", /(?:^|-)nemo(?:-|$)/, "small"],
  ["ovhcloud", /^mistral-nemo-/, "small"],
]

// Order matters: "flash-lite" and "devstral-small" must hit the small words before anything else.
const SMALL_WORDS = /(?:^|[-_/.:\s])(mini|nano|small|tiny|lite|flash|haiku|ministral)(?=$|[-_/.:\s\d])/i
const MEDIUM_WORDS = /(?:^|[-_/.:\s])(medium)(?=$|[-_/.:\s\d])/i
const LARGE_WORDS = /(?:^|[-_/.:\s])(large|opus|fable|pro|max|ultra)(?=$|[-_/.:\s\d])/i
/** Non-chat models get no size tag: they aren't candidates for an agent's model. */
const NOT_CHAT = /embed|whisper|voxtral|tts|image|veo|lyria|guard|realtime|transcri|-live|deep-research/i

/** Total parameters in billions, read from the model id ("7b", "8x22b", "397b-a17b"), if stated. */
export function parameters(id: string): number | undefined {
  const experts = /(?:^|[^a-z\d])(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(id)
  if (experts) return Number(experts[1]) * Number(experts[2])
  // The first bare "<n>b" is the total; an "a<n>b" after it is the active count, so skip "a" prefixes.
  const total = /(?:^|[^a-z\d.])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(id)
  return total ? Number(total[1]) : undefined
}

/** `small`, `medium` or `large` per the documented rules, or undefined rather than a guess. */
export function size(providerID: string, modelID: string, name?: string): Size | undefined {
  if (NOT_CHAT.test(modelID)) return undefined
  const override = OVERRIDES.find(([provider, pattern]) => provider === providerID && pattern.test(modelID))
  if (override) return override[2]
  const billions = parameters(modelID)
  if (billions !== undefined) {
    if (billions <= SMALL_MAX_B) return "small"
    if (billions >= LARGE_MIN_B) return "large"
    return "medium"
  }
  for (const text of [modelID, name ?? ""]) {
    if (SMALL_WORDS.test(text)) return "small"
    if (MEDIUM_WORDS.test(text)) return "medium"
    if (LARGE_WORDS.test(text)) return "large"
  }
  return undefined
}

/** One model's published result (specs/eval/<date>.results.json), as shipped in eval-results.json. */
export type EvalResult = {
  model: string
  date: string
  report: string
  status: "complete" | "incomplete"
  tasks: number
  /** Mean pass rate over the trials. Absent for an incomplete run, which has no result. */
  passRate?: number
  costPerSolved?: number
  /** Where the eval proxy actually sent the model's requests. */
  upstreamHosts: string[]
}

/** The published results this release ships. A function, so it reads the import's live binding. */
export function published(): readonly EvalResult[] {
  return shipped as EvalResult[]
}

/** A model has to pass at least this share of the tasks to be recommended under an EU-only policy. */
export const EU_MIN_PASS_RATE = 0.5

/** Whether every request of the run went to a host whose built-in claim is EU. */
function ranInEu(result: EvalResult) {
  const providerID = result.model.split("/")[0]
  return (
    result.upstreamHosts.length > 0 &&
    result.upstreamHosts.every(
      (host) => Jurisdiction.resolve(providerID, `https://${host}`, undefined).claim.region === "eu",
    )
  )
}

/**
 * The best EU model in the published results, or undefined when none passed `EU_MIN_PASS_RATE`.
 * Only a model's latest result counts, only complete runs, and only runs whose traffic went to an
 * EU host (a Mistral run against the global api.mistral.ai isn't an EU result).
 */
export function euPick(results: readonly EvalResult[] = published()) {
  const latest = new Map<string, EvalResult>()
  for (const result of results) {
    const seen = latest.get(result.model)
    if (!seen || result.date > seen.date) latest.set(result.model, result)
  }
  const eligible = [...latest.values()].filter(
    (result) =>
      result.status === "complete" &&
      result.passRate !== undefined &&
      result.passRate >= EU_MIN_PASS_RATE &&
      ranInEu(result),
  )
  // Highest pass rate; then the cheaper per solved task; then the newer result.
  eligible.sort(
    (a, b) =>
      b.passRate! - a.passRate! ||
      (a.costPerSolved ?? Infinity) - (b.costPerSolved ?? Infinity) ||
      b.date.localeCompare(a.date),
  )
  return eligible[0]
}

/** What the pickers show next to the EU pick, under ~50 characters. */
export function euReason(result: EvalResult) {
  const reason = `Best EU eval: passed ${Math.round(result.passRate! * 100)}% of ${result.tasks} tasks`
  // A provider whose SDK default isn't its EU host (Mistral) is blocked until baseURL points there.
  const claim = Jurisdiction.lookup(result.model.split("/")[0])
  if (claim.defaultHost && claim.hosts && !claim.hosts.includes(claim.defaultHost))
    return `${reason}; set baseURL to ${result.upstreamHosts[0]}`
  return reason
}

/**
 * The recommended list in effect: the organisation's, when config sets one; under an EU-only
 * residency policy, the EU pick or nothing (XCOD-320); else the built-in.
 */
export function recommended(
  configured: Readonly<Record<string, string>> | undefined,
  residency?: { readonly allow?: readonly string[] },
  results: readonly EvalResult[] = published(),
): Readonly<Record<string, string>> {
  if (configured) return configured
  if (!Jurisdiction.euOnly(residency)) return RECOMMENDED
  const pick = euPick(results)
  return pick ? { [pick.model]: euReason(pick) } : {}
}

/** XCOD-320: the default model under an EU-only policy when nothing else chose one, as "provider/model". */
export function euDefault(
  residency: { readonly allow?: readonly string[] } | undefined,
  results: readonly EvalResult[] = published(),
) {
  if (!Jurisdiction.euOnly(residency)) return undefined
  return euPick(results)?.model
}
