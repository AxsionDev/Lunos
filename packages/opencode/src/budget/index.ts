export * as Budget from "./index"

import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ConfigBudget } from "@opencode-ai/core/config/budget"
import { ProjectGroup } from "@/project/group"
import { BudgetPeriod } from "./period"
import { BudgetSpend } from "./spend"
import { BudgetEstimate } from "./estimate"
import { BudgetState } from "./state"
import { BudgetNotify } from "./notify"
import { CloudCostReport } from "@/cloud/cost-report"

// XCOD-298: project budgets. A project's budget is kept on this computer with the project
// (`ProjectGroup.setBudget`); the organisation's comes from managed config, and counts only while
// `$locked` holds it there. `status` says where each budget stands; `guard` is what the session loop
// asks before every step (subagents' included), and decides whether the step runs.

export interface Config {
  budget?: ConfigBudget.Info
  $locked?: readonly string[]
}

export interface Settings {
  on_limit: ConfigBudget.LimitAction
  thresholds: number[]
  currency: ConfigBudget.Currency
  /** What 1 USD is in `currency`. */
  rate: number
}

export function settings(config: Config | undefined): Settings {
  const budget = config?.budget
  const currency = budget?.currency ?? ConfigBudget.DEFAULT_CURRENCY
  return {
    on_limit: budget?.on_limit ?? ConfigBudget.DEFAULT_ON_LIMIT,
    thresholds: [...(budget?.thresholds ?? ConfigBudget.DEFAULT_THRESHOLDS)].sort((a, b) => a - b),
    currency,
    rate: currency === "USD" ? 1 : (budget?.usd_rate ?? ConfigBudget.DEFAULT_USD_RATE),
  }
}

/** "€12.40", "$0.08", "<€0.01". */
export function money(amount: number, currency: ConfigBudget.Currency) {
  const sign = currency === "EUR" ? "€" : "$"
  if (amount > 0 && amount < 0.01) return `<${sign}0.01`
  return `${amount < 0 ? "-" : ""}${sign}${Math.abs(amount).toFixed(2)}`
}

/** The organisation's budget, when managed config sets it and locks it. */
export function organisation(config: Config | undefined) {
  const locked = config?.$locked ?? []
  if (!locked.some((key) => key === "budget" || key === "budget.organisation")) return undefined
  return config?.budget?.organisation
}

export interface Status {
  /** "project:<project id>" or "organisation". */
  id: string
  scope: "project" | "organisation"
  project: { id: string; name: string }
  /** Set by the organisation: can't be changed here. */
  locked: boolean
  budget: ConfigBudget.Budget
  on_limit: ConfigBudget.LimitAction
  currency: ConfigBudget.Currency
  period: BudgetPeriod.Period
  /** In `currency`. */
  amount: number
  spent: number
  remaining: number
  percent: number
  /** Turns of unknown cost (a model without a price) in the period: not in `spent`. */
  unknown: number
  /** At this pace, what the period will have cost by its end (undefined for a total budget). */
  forecast?: number
  today?: { spent: number; cap: number }
  session?: { spent: number; cap: number }
}

// ---------------------------------------------------------------------------------------------
// Spend, read from the database at most every CACHE_MS; steps finished since are added as they
// finish (`spent`), so a limit is seen at the next step, not a minute later.

const CACHE_MS = 30_000
let cache: { at: number; since: number; turns: BudgetSpend.Turn[]; sessions: Map<string, SessionCost> } | undefined
type SessionCost = { parent: string | null; cost: number }
const pending: { session: string; cost: number; time: number }[] = []

/** A finished step's cost (USD), from the session loop. */
export function spent(session: string, cost: number) {
  if (!(cost > 0)) return
  pending.push({ session, cost, time: Date.now() })
  if (pending.length > 10_000) pending.splice(0, pending.length - 10_000)
}

/** For tests, and after a budget changes. */
export function reset() {
  cache = undefined
  pending.length = 0
  approved.clear()
  warned.clear()
  estimates.clear()
}

const load = Effect.fn("Budget.load")(function* (since: number, now: number, fresh: boolean) {
  if (cache && !fresh && cache.since <= since && now - cache.at < CACHE_MS) return cache
  const turns = yield* BudgetSpend.turns(since)
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ id: SessionTable.id, parent: SessionTable.parent_id, cost: SessionTable.cost })
    .from(SessionTable)
    .all()
    .pipe(Effect.orDie)
  cache = { at: now, since, turns, sessions: new Map(rows.map((row) => [row.id as string, row])) }
  return cache
})

/** What a session tree (a session and its subagents) has cost, USD. */
function treeCost(sessions: Map<string, SessionCost>, root: string) {
  let total = 0
  const rootOf = (id: string) => {
    let current = id
    for (let depth = 0; depth < 20; depth++) {
      const parent = sessions.get(current)?.parent
      if (!parent) return current
      current = parent
    }
    return current
  }
  for (const [id, row] of sessions) if (rootOf(id) === root) total += row.cost
  return total
}

export interface Where {
  directory: string
  project?: ProjectGroup.Repository
  /** The session, for its project and its per-session cap. */
  session?: { id: string; parentID?: string }
}

const parents = Effect.fn("Budget.parents")(function* (sessionID: string) {
  const { db } = yield* Database.Service
  const chain = new Map<string, ProjectGroup.SessionRef>()
  let id: string | undefined = sessionID
  for (let depth = 0; id && depth < 20; depth++) {
    const row: { id: string; parent: string | null; directory: string } | undefined = yield* db
      .select({ id: SessionTable.id, parent: SessionTable.parent_id, directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.id, id as never))
      .get()
      .pipe(Effect.orDie)
    if (!row) break
    chain.set(row.id, { id: row.id, directory: row.directory, ...(row.parent ? { parentID: row.parent } : {}) })
    id = row.parent ?? undefined
  }
  return chain
})

/** The project each session counted in at its last check, for the console's cost report. */
const sessionProjects = new Map<string, string>()
export function projectOf(sessionID: string) {
  return sessionProjects.get(sessionID)
}

/** The project a directory (or session) counts in, and the budgets that apply to it. */
export const applicable = Effect.fn("Budget.applicable")(function* (where: Where, config: Config | undefined) {
  const snapshot = yield* Effect.promise(() => ProjectGroup.snapshot())
  const org = organisation(config)
  let group: ProjectGroup.Info | undefined
  // No budget anywhere and no cost report: nothing to look up.
  const idle = !org && !Object.keys(snapshot.budgets).length && !CloudCostReport.active()
  if (where.session && !idle) {
    const chain = yield* parents(where.session.id)
    const own = chain.get(where.session.id) ?? {
      id: where.session.id,
      directory: where.directory,
      ...(where.session.parentID ? { parentID: where.session.parentID } : {}),
    }
    group = snapshot.forSession({ ...own, ...(where.project ? { project: where.project } : {}) }, (id) => {
      const found = chain.get(id)
      return found && where.project ? { ...found, project: where.project } : found
    })
  } else group = snapshot.resolve(where.directory, where.project)
  group ??= ProjectGroup.implicit(where.directory, where.project ?? { id: "global", worktree: "/" })
  if (where.session) {
    sessionProjects.set(where.session.id, group.id)
    if (sessionProjects.size > 5000) sessionProjects.delete(sessionProjects.keys().next().value!)
  }
  const list: { id: string; scope: Status["scope"]; budget: ConfigBudget.Budget; locked: boolean }[] = []
  const own = snapshot.budgets[group.id]
  if (own) list.push({ id: `project:${group.id}`, scope: "project", budget: own, locked: false })
  if (org) list.push({ id: "organisation", scope: "organisation", budget: org, locked: true })
  return { group, budgets: list }
})

/** Where each budget that applies stands. No budget: an empty list, and nothing read. */
export const status = Effect.fn("Budget.status")(function* (
  where: Where,
  config: Config | undefined,
  options: { now?: number; fresh?: boolean } = {},
) {
  const now = options.now ?? Date.now()
  const { group, budgets } = yield* applicable(where, config)
  if (!budgets.length) return [] as Status[]
  const set = settings(config)
  const periods = budgets.map((item) => BudgetPeriod.of(item.budget, now))
  const day = BudgetPeriod.today(now)
  const since = Math.min(day, ...periods.map((period) => period.start))
  const data = yield* load(since, now, options.fresh ?? false)
  const sessionRoot = where.session ? yield* BudgetSpend.root(where.session.id) : undefined
  // Steps that finished since the database was read, in this process, in this project.
  const projectOfSession = new Map(data.turns.map((turn) => [turn.session, turn.project]))
  if (where.session) projectOfSession.set(where.session.id, group.id)
  const later = pending.filter((item) => item.time > data.at)
  const result: Status[] = []
  budgets.forEach((item, index) => {
    const period = periods[index]!
    const mine = (turn: { project: string }) => item.scope === "organisation" || turn.project === group.id
    const inPeriod = BudgetSpend.total(
      data.turns,
      (turn) => mine(turn) && turn.time >= period.start && turn.time < period.end,
    )
    const extra = later
      .filter((entry) => item.scope === "organisation" || projectOfSession.get(entry.session) === group.id)
      .reduce((sum, entry) => sum + entry.cost, 0)
    const spentUSD = inPeriod.spent + extra
    const todayUSD = BudgetSpend.total(data.turns, (turn) => mine(turn) && turn.time >= day).spent + extra
    const spent = spentUSD * set.rate
    const amount = item.budget.amount
    const elapsed = now - period.start
    const length = period.end - period.start
    const forecast =
      period.end === Infinity || elapsed <= 0 ? undefined : spent + (spent / elapsed) * Math.max(0, length - elapsed)
    const sessionUSD =
      sessionRoot !== undefined
        ? treeCost(data.sessions, sessionRoot) +
          later.reduce((sum, entry) => {
            // Steps since the read, of this session tree.
            let id: string | undefined = entry.session
            for (let depth = 0; id && depth < 20; depth++) {
              if (id === sessionRoot) return sum + entry.cost
              id = data.sessions.get(id)?.parent ?? undefined
            }
            return sum
          }, 0)
        : undefined
    result.push({
      id: item.id,
      scope: item.scope,
      project: { id: group.id, name: item.scope === "organisation" ? "Your organisation" : group.name },
      locked: item.locked,
      budget: item.budget,
      on_limit: item.budget.on_limit ?? set.on_limit,
      currency: set.currency,
      period,
      amount,
      spent,
      remaining: amount - spent,
      percent: amount > 0 ? (spent / amount) * 100 : 0,
      unknown: inPeriod.unknown,
      ...(forecast !== undefined ? { forecast } : {}),
      ...(item.budget.per_day ? { today: { spent: todayUSD * set.rate, cap: item.budget.per_day } } : {}),
      ...(item.budget.per_session && sessionUSD !== undefined
        ? { session: { spent: sessionUSD * set.rate, cap: item.budget.per_session } }
        : {}),
    })
  })
  return result
})

/** "€12.40 left of €50 (Oct)", or "€0.30 over €50 (Oct)". */
export function left(item: Pick<Status, "remaining" | "amount" | "currency" | "period">) {
  const of = `${money(item.amount, item.currency)} (${item.period.label})`
  return item.remaining >= 0
    ? `${money(item.remaining, item.currency)} left of ${of}`
    : `${money(-item.remaining, item.currency)} over ${of}`
}

/** "est. €0.08–0.30 · €12.40 left of €50 (Oct)": what the prompt shows before a turn. */
export function line(input: {
  estimate?: BudgetEstimate.Range
  unpriced?: boolean
  status?: Status
  settings: Settings
}) {
  const parts: string[] = []
  const currency = input.status?.currency ?? input.settings.currency
  if (input.estimate)
    parts.push(
      `est. ${money(input.estimate.low * input.settings.rate, currency)}–${money(input.estimate.high * input.settings.rate, currency).replace(/^[<]?[€$]/, "")}`,
    )
  else if (input.unpriced) parts.push("unknown cost (set a price for this model)")
  if (input.status) parts.push(left(input.status) + (input.status.unknown ? ` + ${input.status.unknown} unknown` : ""))
  return parts.join(" · ")
}

/** The budget that limits most: the one with the least left, as a share of it. */
export function tightest(list: readonly Status[]) {
  return [...list].sort((a, b) => a.remaining / a.amount - b.remaining / b.amount)[0]
}

// ---------------------------------------------------------------------------------------------
// The guard: before every step.

export interface Turn {
  /** USD costs of the session's finished turns, oldest first. */
  recent: number[]
  context: number
  cached: number
}

/** The session's recent turn costs and the context the next call starts with, from its messages. */
export function turnsOf(
  messages: readonly { info: { role: string; parentID?: string; cost?: number; tokens?: any } }[],
): Turn {
  const costs = new Map<string, number>()
  let context = 0
  let cached = 0
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    const parent = message.info.parentID ?? ""
    costs.set(parent, (costs.get(parent) ?? 0) + (Number(message.info.cost) || 0))
    const tokens = message.info.tokens
    if (tokens) {
      const read = Number(tokens.cache?.read) || 0
      const write = Number(tokens.cache?.write) || 0
      context = (Number(tokens.input) || 0) + read + write + (Number(tokens.output) || 0)
      cached = read + write
    }
  }
  return { recent: [...costs.values()].filter((value) => value > 0), context, cached }
}

export type Decision =
  | { action: "run"; toasts: string[] }
  | { action: "warn"; message: string; toasts: string[] }
  | { action: "ask"; message: string; toasts: string[]; root: string }
  | { action: "stop"; message: string; toasts: string[] }

/** Root sessions whose current turn the user chose to run anyway. Cleared when the next turn starts. */
const approved = new Set<string>()
/** Root sessions already warned this turn. */
const warned = new Set<string>()
/** The estimate shown before each root session's current turn (USD). */
const estimates = new Map<string, { low: number; high: number; model?: string }>()

export function approve(root: string) {
  approved.add(root)
}

/** Whether nobody can answer a question in this run: `lunos run`, CI, an unattended agent. */
export function unattended(
  permission: readonly { permission: string; action: string; pattern?: string }[] | null | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.CI && env.CI !== "false" && env.CI !== "0") return true
  return !!permission?.some((rule) => rule.permission === "question" && rule.action === "deny")
}

function raise(item: Status) {
  if (item.scope === "organisation") return "Your organisation set this budget; ask an owner or admin to raise it."
  const next =
    item.period.end === Infinity ? "" : `, or wait until it resets on ${new Date(item.period.end).toDateString()}`
  return `Raise it with lunos budget set "${item.project.name}" <amount> or in /projects${next}.`
}

/**
 * Before a step. `start` is the first step of a turn in a root session: then the turn's estimate is
 * checked against what's left; otherwise only whether a limit has been reached. A step already
 * running is never stopped: this only decides whether the next one starts.
 */
export const guard = Effect.fn("Budget.guard")(function* (input: {
  session: { id: string; parentID?: string }
  directory: string
  project?: ProjectGroup.Repository
  config: Config | undefined
  start: boolean
  price?: BudgetEstimate.Price
  /** "provider/model", for the accuracy record. */
  model?: string
  turn: Turn
  now?: number
}) {
  const list = yield* status(
    { directory: input.directory, project: input.project, session: input.session },
    input.config,
    { now: input.now, fresh: input.start },
  )
  if (!list.length) return { action: "run", toasts: [] } as Decision
  const set = settings(input.config)
  const root = yield* BudgetSpend.root(input.session.id)
  if (input.start && !input.session.parentID) {
    approved.delete(root)
    warned.delete(root)
  }
  const toasts: string[] = []
  for (const item of list) {
    const crossed = set.thresholds.filter((value) => item.percent >= value)
    const fresh = yield* Effect.promise(() => BudgetState.claim(item.id, item.period.key, crossed))
    for (const threshold of fresh)
      BudgetNotify.notify({
        budget: item.id,
        project: item.project.name,
        threshold,
        period: item.period.label,
        spent: item.spent,
        amount: item.amount,
        currency: item.currency,
      })
    if (fresh.length)
      toasts.push(
        `${item.project.name} has used ${Math.max(...fresh)}% of its ${item.period.label} budget (${money(item.spent, item.currency)} of ${money(item.amount, item.currency)})`,
      )
  }
  // The accuracy record: the estimate shown before the root's last turn, against what it cost.
  if (input.start && !input.session.parentID) {
    const shown = estimates.get(root)
    const actual = input.turn.recent.at(-1)
    if (shown && actual !== undefined)
      yield* Effect.promise(() =>
        recordAccuracy({
          time: Date.now(),
          session: root,
          model: shown.model,
          low: shown.low,
          high: shown.high,
          actual,
        }),
      )
    estimates.delete(root)
  }
  const estimate = input.start
    ? BudgetEstimate.estimate({
        context: input.turn.context,
        cached: input.turn.cached,
        price: input.price,
        recent: input.turn.recent,
      })
    : undefined
  if (estimate && input.start && !input.session.parentID)
    estimates.set(root, { low: estimate.low, high: estimate.high, ...(input.model ? { model: input.model } : {}) })
  const reasons: { item: Status; message: string }[] = []
  for (const item of list) {
    const high = (estimate?.high ?? 0) * set.rate
    if (item.spent >= item.amount)
      reasons.push({
        item,
        message: `${item.project.name} has used its ${item.period.label} budget (${money(item.spent, item.currency)} of ${money(item.amount, item.currency)}).`,
      })
    else if (estimate && item.spent + high > item.amount)
      reasons.push({
        item,
        message: `This turn may take ${item.project.name} over budget (est. ${money(high, item.currency)}, ${money(item.remaining, item.currency)} left of ${money(item.amount, item.currency)} (${item.period.label})).`,
      })
    if (item.today && item.today.spent >= item.today.cap)
      reasons.push({
        item,
        message: `${item.project.name} has used its daily cap (${money(item.today.spent, item.currency)} of ${money(item.today.cap, item.currency)} today).`,
      })
    if (item.session && item.session.spent >= item.session.cap)
      reasons.push({
        item,
        message: `This session has used its cap (${money(item.session.spent, item.currency)} of ${money(item.session.cap, item.currency)}).`,
      })
  }
  if (!reasons.length) return { action: "run", toasts } as Decision
  const rank = { warn: 0, ask: 1, stop: 2 } as const
  const worst = reasons.reduce((a, b) => (rank[b.item.on_limit] > rank[a.item.on_limit] ? b : a))
  let action = worst.item.on_limit
  if (action === "ask") {
    if (approved.has(root)) return { action: "run", toasts } as Decision
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ permission: SessionTable.permission })
      .from(SessionTable)
      .where(eq(SessionTable.id, root as never))
      .get()
      .pipe(Effect.orDie)
    if (unattended(row?.permission)) action = "stop"
  }
  const message = worst.message
  if (action === "stop") return { action: "stop", message: `${message} ${raise(worst.item)}`, toasts } as Decision
  if (action === "ask") return { action: "ask", message, toasts, root } as Decision
  if (warned.has(root)) return { action: "run", toasts } as Decision
  warned.add(root)
  return { action: "warn", message, toasts } as Decision
})

/**
 * XCOD-303: the reason a limit with `on_limit: stop` has been reached (the budget, the day's cap or
 * the session's), or undefined. Pure: unlike `guard` it claims no thresholds and records nothing,
 * so the task tool can ask it before every dispatch.
 */
export function stopped(list: readonly Status[]) {
  for (const item of list) {
    if (item.on_limit !== "stop") continue
    if (item.spent >= item.amount)
      return `${item.project.name} has used its ${item.period.label} budget (${money(item.spent, item.currency)} of ${money(item.amount, item.currency)}). ${raise(item)}`
    if (item.today && item.today.spent >= item.today.cap)
      return `${item.project.name} has used its daily cap (${money(item.today.spent, item.currency)} of ${money(item.today.cap, item.currency)} today).`
    if (item.session && item.session.spent >= item.session.cap)
      return `This session has used its cap (${money(item.session.spent, item.currency)} of ${money(item.session.cap, item.currency)}).`
  }
}

/** XCOD-303: before a subagent is dispatched: why no new one may start, or undefined. */
export const dispatchStop = Effect.fn("Budget.dispatchStop")(function* (where: Where, config: Config | undefined) {
  return stopped(yield* status(where, config))
})

/** After a turn: the estimate shown before it, against what it cost (USD), for the accuracy record. */
export async function recordAccuracy(entry: BudgetState.Accuracy) {
  await BudgetState.record(entry).catch(() => undefined)
}
