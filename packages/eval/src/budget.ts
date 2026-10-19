// XCOD-119: the spend ledger. A request reserves its worst-case cost before it is forwarded and
// settles to its measured cost afterwards, so spend can't pass a cap between two checks.
//
// With a file, the ledger is append-only on disk and loads what earlier runs spent, so the caps
// apply to everything spent under one budget: a pilot and the baseline after it, or a run
// restarted after a crash, can't each start from zero.

import fs from "fs"
import path from "path"

export type Caps = { total: number; classes: Record<string, number> }

export type Entry = {
  at: string
  model: string
  cls: string
  upstream: string
  reserved: number
  cost: number
  usage?: { input: number; output: number; cacheRead?: number }
  /** HTTP status from the provider, when there was a response. */
  httpStatus?: number
  status: "settled" | "refused" | "failed"
}

export class BudgetExceeded extends Error {
  constructor(
    readonly scope: string,
    readonly needed: number,
    readonly left: number,
  ) {
    super(`eval budget: ${scope} has €${left.toFixed(4)} left, this request could cost up to €${needed.toFixed(4)}`)
    this.name = "BudgetExceeded"
  }
}

export class Ledger {
  readonly entries: Entry[] = []
  private held = new Map<string, number>()
  private spent = new Map<string, number>()

  constructor(
    readonly caps: Caps,
    private readonly file?: string,
  ) {
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (!fs.existsSync(file)) return
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue
      const entry = JSON.parse(line) as Entry
      this.entries.push(entry)
      this.spent.set(entry.cls, this.spentClass(entry.cls) + entry.cost)
    }
  }

  private record(entry: Entry) {
    this.entries.push(entry)
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(entry) + "\n")
  }

  /** Whether `amount` still fits both the class cap and the total, without reserving it. */
  canAfford(cls: string, amount: number) {
    const classCap = this.caps.classes[cls] ?? 0
    return (
      amount <= classCap - this.spentClass(cls) - (this.held.get(cls) ?? 0) &&
      amount <= this.caps.total - this.spentTotal() - this.heldTotal()
    )
  }

  spentTotal() {
    return [...this.spent.values()].reduce((a, b) => a + b, 0)
  }

  spentClass(cls: string) {
    return this.spent.get(cls) ?? 0
  }

  private heldTotal() {
    return [...this.held.values()].reduce((a, b) => a + b, 0)
  }

  /** Reserves `amount` for a request, or throws BudgetExceeded without reserving anything. */
  reserve(cls: string, amount: number) {
    const classCap = this.caps.classes[cls]
    if (classCap === undefined) throw new Error(`eval budget: no cap for class "${cls}"`)
    const classLeft = classCap - this.spentClass(cls) - (this.held.get(cls) ?? 0)
    if (amount > classLeft) throw new BudgetExceeded(`class "${cls}"`, amount, classLeft)
    const totalLeft = this.caps.total - this.spentTotal() - this.heldTotal()
    if (amount > totalLeft) throw new BudgetExceeded("the total", amount, totalLeft)
    this.held.set(cls, (this.held.get(cls) ?? 0) + amount)
    let released = false
    return (entry: Omit<Entry, "reserved" | "cls" | "at">) => {
      if (released) return
      released = true
      this.held.set(cls, (this.held.get(cls) ?? 0) - amount)
      // A 2xx reply with no usage may still have been billed, so it is charged its reservation. A
      // provider error (4xx/5xx) without usage is recorded but not charged: providers don't bill
      // rejected requests, and charging them would let a burst of 429s drain the budget.
      const charged = entry.status === "settled" ? entry.cost : (entry.httpStatus ?? 0) >= 400 ? 0 : amount
      this.spent.set(cls, this.spentClass(cls) + charged)
      this.record({ ...entry, cost: charged, cls, reserved: amount, at: new Date().toISOString() })
    }
  }

  refuse(model: string, cls: string, upstream: string, needed: number) {
    this.record({
      at: new Date().toISOString(),
      model,
      cls,
      upstream,
      reserved: needed,
      cost: 0,
      status: "refused",
    })
  }
}
