export * as BudgetState from "./state"

import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"

// XCOD-298: what budgets remember on this computer, in the state directory: which thresholds have
// alerted in which period (each alerts once per period), and how close the estimates shown before
// each turn came to what the turn cost. Never sent anywhere.

export interface Accuracy {
  time: number
  session: string
  model?: string
  /** USD. */
  low: number
  high: number
  actual: number
}

interface State {
  version: 1
  /** Budget id ("project:<id>", "organisation") to period key to the thresholds that have alerted. */
  alerts: Record<string, Record<string, number[]>>
  accuracy: Accuracy[]
}

/** The accuracy record keeps the newest this many turns. */
export const ACCURACY_MAX = 500

export const file = () => path.join(Global.Path.state, "budget-state.json")

const empty = (): State => ({ version: 1, alerts: {}, accuracy: [] })

async function read(): Promise<State> {
  const text = await fsp.readFile(file(), "utf8").catch(() => undefined)
  if (text === undefined) return empty()
  try {
    const value = JSON.parse(text)
    return {
      version: 1,
      alerts: value?.alerts && typeof value.alerts === "object" ? value.alerts : {},
      accuracy: Array.isArray(value?.accuracy) ? value.accuracy : [],
    }
  } catch {
    return empty()
  }
}

async function update<T>(change: (state: State) => T): Promise<T> {
  return Flock.withLock(`budget-state:${file()}`, async () => {
    const state = await read()
    const result = change(state)
    await fsp.mkdir(path.dirname(file()), { recursive: true })
    const next = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
    await fsp.writeFile(next, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
    await fsp.rename(next, file())
    return result
  })
}

/**
 * The thresholds of `crossed` that haven't alerted yet in this period, now marked as alerted. Under
 * the lock, so two Lunos processes crossing the same one alert once between them.
 */
export async function claim(budget: string, period: string, crossed: readonly number[]): Promise<number[]> {
  if (!crossed.length) return []
  const known = (await read()).alerts[budget]?.[period] ?? []
  if (crossed.every((value) => known.includes(value))) return []
  return update((state) => {
    const periods = (state.alerts[budget] ??= {})
    // Only this period and the one before are kept.
    for (const key of Object.keys(periods).sort().slice(0, -1)) if (key !== period) delete periods[key]
    const done = (periods[period] ??= [])
    const fresh = crossed.filter((value) => !done.includes(value))
    done.push(...fresh)
    return fresh
  })
}

export async function alerted(budget: string, period: string) {
  return (await read()).alerts[budget]?.[period] ?? []
}

export async function record(entry: Accuracy) {
  await update((state) => {
    state.accuracy.push(entry)
    if (state.accuracy.length > ACCURACY_MAX) state.accuracy.splice(0, state.accuracy.length - ACCURACY_MAX)
  })
}

export async function accuracy(): Promise<Accuracy[]> {
  return (await read()).accuracy
}
