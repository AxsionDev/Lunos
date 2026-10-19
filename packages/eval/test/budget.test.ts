import { describe, expect, test } from "bun:test"
import { BudgetExceeded, Ledger } from "../src/budget"
import { cost, requirePrices, worstCase, type ApiPrice } from "../src/prices"

const price: ApiPrice = {
  kind: "api",
  input: 2,
  output: 6,
  cacheRead: 0.2,
  maxOutputTokens: 1000,
  source: "test",
  checked: "2026-09-27",
}

describe("prices", () => {
  test("cost uses € per 1M tokens, with cached input at the cache rate", () => {
    expect(cost(price, { input: 1_000_000, output: 0 })).toBe(2)
    expect(cost(price, { input: 1_000_000, output: 1_000_000, cacheRead: 500_000 })).toBeCloseTo(1 + 0.1 + 6)
  })

  test("worst case counts every byte as a token plus the largest completion allowed", () => {
    expect(worstCase(price, 1000)).toBeCloseTo((1000 * 2 + 1000 * 6) / 1e6)
    expect(worstCase(price, 1000, 100)).toBeCloseTo((1000 * 2 + 100 * 6) / 1e6)
    expect(worstCase(price, 1000, 999_999)).toBeCloseTo((1000 * 2 + 1000 * 6) / 1e6)
  })

  test("an unpriced model is refused before anything runs", () => {
    expect(() => requirePrices(["mistral/x", "local/free"], { "mistral/x": price })).toThrow("No price for local/free")
    expect(() =>
      requirePrices(["gpu/qwen"], { "gpu/qwen": { kind: "gpu", perHour: 0, source: "", checked: "" } }),
    ).toThrow()
  })
})

describe("ledger", () => {
  test("a reservation that would pass a class cap or the total is refused, and reserves nothing", () => {
    const ledger = new Ledger({ total: 1, classes: { eu: 0.5, frontier: 0.8 } })
    expect(() => ledger.reserve("eu", 0.6)).toThrow(BudgetExceeded)
    const settle = ledger.reserve("frontier", 0.8)
    expect(() => ledger.reserve("eu", 0.3)).toThrow("the total has €0.2000 left")
    settle({ model: "m", upstream: "h", cost: 0.1, status: "settled" })
    expect(ledger.spentTotal()).toBeCloseTo(0.1)
    expect(() => ledger.reserve("eu", 0.3)).not.toThrow()
  })

  test("an unmeasured request is charged its full reservation", () => {
    const ledger = new Ledger({ total: 1, classes: { eu: 1 } })
    ledger.reserve("eu", 0.4)({ model: "m", upstream: "h", cost: 0, status: "failed" })
    expect(ledger.spentTotal()).toBeCloseTo(0.4)
  })

  test("a provider error without usage is recorded but not charged", () => {
    const ledger = new Ledger({ total: 1, classes: { eu: 1 } })
    ledger.reserve("eu", 0.4)({ model: "m", upstream: "h", cost: 0, status: "failed", httpStatus: 429 })
    expect(ledger.spentTotal()).toBe(0)
    expect(ledger.entries[0].httpStatus).toBe(429)
  })

  test("spend persists: a new run under the same budget starts from what was already spent", async () => {
    const file = `${require("os").tmpdir()}/ledger-${Math.random().toString(36).slice(2)}/new-dir/ledger.jsonl`
    const first = new Ledger({ total: 1, classes: { eu: 1 } }, file)
    first.reserve("eu", 0.7)({ model: "m", upstream: "h", cost: 0.6, status: "settled" })
    const second = new Ledger({ total: 1, classes: { eu: 1 } }, file)
    expect(second.spentTotal()).toBeCloseTo(0.6)
    expect(() => second.reserve("eu", 0.5)).toThrow(BudgetExceeded)
    expect(second.canAfford("eu", 0.3)).toBe(true)
  })

  test("settling twice counts once", () => {
    const ledger = new Ledger({ total: 1, classes: { eu: 1 } })
    const settle = ledger.reserve("eu", 0.4)
    settle({ model: "m", upstream: "h", cost: 0.1, status: "settled" })
    settle({ model: "m", upstream: "h", cost: 0.1, status: "settled" })
    expect(ledger.spentTotal()).toBeCloseTo(0.1)
    expect(ledger.entries).toHaveLength(1)
  })
})
