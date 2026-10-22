export * as ConfigBudget from "./budget"

import { Schema } from "effect"

/**
 * XCOD-298: project budgets. A project's own budget is kept on this computer with the project
 * (`lunos budget set`, /projects), never in config: a repository's config can't raise it. Config
 * holds what happens at the limit, the alert thresholds, the currency and, from an organisation's
 * managed config only, the organisation's budget. Declared in both the v1 and v2 config schemas.
 */

export const LIMIT_ACTIONS = ["warn", "ask", "stop"] as const
export type LimitAction = (typeof LIMIT_ACTIONS)[number]
export const PERIODS = ["monthly", "weekly", "total"] as const
export type Period = (typeof PERIODS)[number]
export const CURRENCIES = ["EUR", "USD"] as const
export type Currency = (typeof CURRENCIES)[number]

export const DEFAULT_ON_LIMIT: LimitAction = "ask"
export const DEFAULT_THRESHOLDS = [50, 80, 100] as const
export const DEFAULT_CURRENCY: Currency = "EUR"
/**
 * What 1 USD (the model catalogue's prices) is in EUR, when no `budget.usd_rate` is set. A fixed
 * rate, not a live one: Lunos never fetches exchange rates.
 */
export const DEFAULT_USD_RATE = 0.9

const positive = Schema.Number.check(Schema.isGreaterThan(0))

/** One budget: a project's (kept on this computer), or the organisation's (managed config). */
export const Budget = Schema.Struct({
  amount: positive.annotate({ description: "The budget for each period, in budget.currency" }),
  period: Schema.Literals(PERIODS).pipe(Schema.optional).annotate({
    description:
      '"monthly" (default): resets on reset_day each month. "weekly": resets every Monday. "total": one amount for the project, never reset',
  }),
  reset_day: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 28 }))
    .pipe(Schema.optional)
    .annotate({
      description: "With a monthly period: the day of the month it resets on, 1 to 28. Default 1",
    }),
  per_session: positive.pipe(Schema.optional).annotate({
    description: "Most one session may spend, its subagents included, in budget.currency",
  }),
  per_day: positive.pipe(Schema.optional).annotate({
    description: "Most the project may spend in one day, in budget.currency",
  }),
  on_limit: Schema.Literals(LIMIT_ACTIONS).pipe(Schema.optional).annotate({
    description: "What happens at the limit for this budget; default budget.on_limit",
  }),
}).annotate({ identifier: "BudgetLimit" })
export type Budget = Schema.Schema.Type<typeof Budget>

export const Info = Schema.Struct({
  on_limit: Schema.Literals(LIMIT_ACTIONS).pipe(Schema.optional).annotate({
    description:
      'When a turn may take a project over its budget. "warn": a warning, and the turn runs. "ask" (default): you choose to run it anyway, pick a cheaper model or stop. "stop": no new turn or step starts until the period resets or the budget is raised; a step already running finishes. In `lunos run`, CI and unattended runs nobody can answer, so "ask" stops, and the run exits with code 3',
  }),
  thresholds: Schema.mutable(Schema.Array(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))))
    .pipe(Schema.optional)
    .annotate({
      description: "Percentages of a budget at which you're alerted, once each per period. Default [50, 80, 100]",
    }),
  currency: Schema.Literals(CURRENCIES).pipe(Schema.optional).annotate({
    description: 'The currency budgets are in: "EUR" (default) or "USD"',
  }),
  usd_rate: positive.pipe(Schema.optional).annotate({
    description: `With budget.currency "EUR": what 1 USD is in EUR, for model prices (which are in USD). A fixed rate you set; Lunos never fetches one. Default ${DEFAULT_USD_RATE}`,
  }),
  organisation: Budget.pipe(Schema.optional).annotate({
    description:
      'Your organisation\'s budget for everything Lunos spends on this computer. Enforced only from managed config locked with "$locked": ["budget.organisation"], so members see it but can\'t raise it. Where a project budget applies too, whichever is reached first stops',
  }),
}).annotate({ identifier: "BudgetConfig" })
export type Info = Schema.Schema.Type<typeof Info>
