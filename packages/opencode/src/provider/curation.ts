export * as ModelCuration from "./curation"

/**
 * Model size tags and the curated "Recommended" list (XCOD-213).
 *
 * "Recommended" is a curated choice maintained by Lunos and shipped with each release. It is
 * not an evaluation or a benchmark: there are no published eval results for these models yet
 * (XCOD-200 ran one US model). Say so wherever the list is shown, and update it when there are.
 */

export type Size = "large" | "medium" | "small"

/** Parameter-count thresholds, in billions of total parameters (MoE: total, not active). */
export const SMALL_MAX_B = 15
export const LARGE_MIN_B = 70

/**
 * Curated defaults, "provider/model" → why. EU-hosted and local models only, to match the
 * residency defaults Lunos is built around. Reasons stay under ~50 characters so they fit the
 * TUI picker's detail line. An organisation replaces this list with the
 * `recommended` config key (lockable with `$locked`).
 */
export const RECOMMENDED: Readonly<Record<string, string>> = {
  "mistral/mistral-medium-latest": "EU-hosted (France); a balanced default for coding",
  "mistral/mistral-large-latest": "EU-hosted (France); flagship for hard reasoning",
  "mistral/codestral-latest": "EU-hosted (France); fast for completion and edits",
  "mistral/mistral-small-latest": "EU-hosted (France); cheap, fast for simple tasks",
  "scaleway/qwen3-coder-30b-a3b-instruct": "EU-hosted (Scaleway, France); open-weight coder",
  "ovhcloud/qwen3-coder-30b-a3b-instruct": "EU-hosted (OVHcloud, France); open-weight coder",
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

/** The recommended list in effect: the organisation's, when config sets one, else the built-in. */
export function recommended(configured: Readonly<Record<string, string>> | undefined) {
  return configured ?? RECOMMENDED
}
