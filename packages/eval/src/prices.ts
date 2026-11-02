// XCOD-119: the harness's own price table. Spend is metered from these rates, never from Lunos's
// reported cost: a model without a catalogue price reports 0, which would never trip a cap.

export type ApiPrice = {
  kind: "api"
  /** € per 1M tokens. */
  input: number
  output: number
  cacheRead?: number
  /** Largest completion the model can return; bounds a request's worst-case cost. */
  maxOutputTokens: number
  source: string
  checked: string
}

/** Self-hosted: billed by the GPU hour whether or not requests are running. */
export type GpuPrice = { kind: "gpu"; perHour: number; source: string; checked: string }

export type Price = ApiPrice | GpuPrice

export type Usage = { input: number; output: number; cacheRead?: number }

/** € for one request's measured usage. Cached input is billed at the cache rate when there is one. */
export function cost(price: ApiPrice, usage: Usage) {
  const cached = Math.min(usage.cacheRead ?? 0, usage.input)
  const fresh = usage.input - cached
  const rate = price.cacheRead ?? price.input
  return (fresh * price.input + cached * rate + usage.output * price.output) / 1_000_000
}

/**
 * The most a request can cost before it is sent: every prompt byte counted as a token (tokenizers
 * give well under one token per byte, so this over-estimates) plus the largest possible completion.
 */
export function worstCase(price: ApiPrice, requestBytes: number, maxTokens?: number) {
  const output = Math.min(maxTokens ?? price.maxOutputTokens, price.maxOutputTokens)
  return cost(price, { input: requestBytes, output })
}

/** Throws unless every model has a usable price: an unpriced model can't be capped. */
export function requirePrices(models: string[], table: Record<string, Price>) {
  const missing = models.filter((model) => {
    const price = table[model]
    if (!price) return true
    if (price.kind === "gpu") return !(price.perHour > 0)
    return !(price.input > 0 && price.output > 0 && price.maxOutputTokens > 0)
  })
  if (missing.length)
    throw new Error(`No price for ${missing.join(", ")}: add it to the eval price table before running`)
}
