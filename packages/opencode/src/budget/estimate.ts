export * as BudgetEstimate from "./estimate"

// XCOD-298: what the next turn may cost, as a range, before it runs. From two things:
// - the context it starts with, priced at the model's input price (a cached prefix at the cache
//   price, when the model has one): what one model call costs at least;
// - the session's recent turns (every step of each, in USD): from their 10th to their 95th
//   percentile, so about 85% of turns like them land inside it.
// A turn is usually several steps, so without history the range is wide. All amounts are USD.

export interface Price {
  /** USD per million tokens. */
  input: number
  output: number
  cache?: { read?: number; write?: number }
}

export interface Input {
  /** Tokens the next call sends: the last step's input plus its cached tokens. */
  context: number
  /** The cached part of `context`, priced at the cache price. */
  cached?: number
  price: Price | undefined
  /** The costs of the session's recent turns, oldest first. */
  recent: readonly number[]
}

export interface Range {
  low: number
  high: number
  /** How many recent turns it's based on. */
  basis: number
}

/** The p-th percentile (0..100) of `values`, by linear interpolation. */
export function percentile(values: readonly number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p / 100) * (sorted.length - 1)
  const low = Math.floor(at)
  const high = Math.ceil(at)
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low)
}

/** True when the model has no price: its cost can't be estimated or counted ("unknown cost"). */
export function unpriced(price: Price | undefined) {
  return !price || (!(price.input > 0) && !(price.output > 0))
}

/** The range, or undefined when the model has no price. */
export function estimate(input: Input): Range | undefined {
  if (unpriced(input.price)) return undefined
  const price = input.price!
  const cached = Math.min(input.cached ?? 0, input.context)
  const call = ((input.context - cached) * price.input + cached * (price.cache?.read ?? price.input)) / 1_000_000
  // The last 20 turns: the session's current pace.
  const recent = input.recent.slice(-20).filter((value) => Number.isFinite(value) && value >= 0)
  if (recent.length < 3) return { low: call, high: Math.max(call * 5, call + 0.01), basis: recent.length }
  return {
    low: Math.min(percentile(recent, 10), call),
    high: Math.max(percentile(recent, 95), call),
    basis: recent.length,
  }
}

/** Whether `actual` fell in the range: what the accuracy record counts. */
export function hit(range: Pick<Range, "low" | "high">, actual: number) {
  return actual >= range.low - 1e-9 && actual <= range.high + 1e-9
}
