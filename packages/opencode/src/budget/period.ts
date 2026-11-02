export * as BudgetPeriod from "./period"

import type { ConfigBudget } from "@opencode-ai/core/config/budget"

// XCOD-298: a budget's periods, in local time. Monthly periods start on reset_day (1 to 28, so every
// month has it), weekly ones on Monday, and a "total" budget has one period that never ends.

export interface Period {
  /** Stable id for the period: "2026-10", "2026-10-15", "w2026-10-19", "total". */
  key: string
  /** For people: "Oct", "15 Oct – 14 Nov", "week of 19 Oct", "total". */
  label: string
  start: number
  /** Exclusive; Infinity for a total budget. */
  end: number
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (n: number) => String(n).padStart(2, "0")
const day = (date: Date) => `${date.getDate()} ${MONTHS[date.getMonth()]}`

/** The period `now` is in. */
export function of(budget: Pick<ConfigBudget.Budget, "period" | "reset_day">, now = Date.now()): Period {
  const period = budget.period ?? "monthly"
  if (period === "total") return { key: "total", label: "total", start: 0, end: Infinity }
  const date = new Date(now)
  if (period === "weekly") {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7))
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
    return {
      key: `w${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
      label: `week of ${day(start)}`,
      start: start.getTime(),
      end: end.getTime(),
    }
  }
  const reset = Math.min(28, Math.max(1, budget.reset_day ?? 1))
  const month = date.getDate() >= reset ? date.getMonth() : date.getMonth() - 1
  const start = new Date(date.getFullYear(), month, reset)
  const end = new Date(start.getFullYear(), start.getMonth() + 1, reset)
  const last = new Date(end.getTime() - 1)
  return {
    key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}${reset === 1 ? "" : `-${pad(reset)}`}`,
    label: reset === 1 ? MONTHS[start.getMonth()]! : `${day(start)} – ${day(last)}`,
    start: start.getTime(),
    end: end.getTime(),
  }
}

/** The period before `period` (the same one for a total budget). */
export function previous(budget: Pick<ConfigBudget.Budget, "period" | "reset_day">, period: Period): Period {
  if (period.end === Infinity) return period
  return of(budget, period.start - 1)
}

/** `count` periods, the current one first. */
export function last(budget: Pick<ConfigBudget.Budget, "period" | "reset_day">, count: number, now = Date.now()) {
  const list = [of(budget, now)]
  while (list.length < count && list.at(-1)!.end !== Infinity) list.push(previous(budget, list.at(-1)!))
  return list
}

/** A period named on the command line: "2026-10" (a month), "2026-10-15" (a monthly period from that day), or "total". */
export function parse(budget: Pick<ConfigBudget.Budget, "period" | "reset_day">, text: string): Period | undefined {
  if (text === "total") return of({ period: "total" })
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text.trim())
  if (!match) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3] ?? budget.reset_day ?? 1))
  if (Number.isNaN(date.getTime())) return undefined
  return of(budget.period === "weekly" || budget.period === "total" ? { period: "monthly" } : budget, date.getTime())
}

/** The start of the local day `now` is in. */
export function today(now = Date.now()) {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}
