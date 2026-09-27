// XCOD-119: the spend ledger. A request reserves its worst-case cost before it is forwarded and
// settles to its measured cost afterwards, so spend can't pass a cap between two checks.

export type Caps = { total: number; classes: Record<string, number> }

export type Entry = {
  at: string
  model: string
  cls: string
  upstream: string
  reserved: number
  cost: number
  usage?: { input: number; output: number; cacheRead?: number }
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

  constructor(readonly caps: Caps) {}

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
      // Never record less than was spent: a failed or unmeasured request is charged its reservation.
      const charged = entry.status === "settled" ? entry.cost : amount
      this.spent.set(cls, this.spentClass(cls) + charged)
      this.entries.push({ ...entry, cost: charged, cls, reserved: amount, at: new Date().toISOString() })
    }
  }

  refuse(model: string, cls: string, upstream: string, needed: number) {
    this.entries.push({
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
