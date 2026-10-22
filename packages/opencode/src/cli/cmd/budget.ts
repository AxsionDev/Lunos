import { EOL } from "os"
import fs from "fs/promises"
import { Effect } from "effect"
import { ConfigBudget } from "@opencode-ai/core/config/budget"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectGroup } from "@/project/group"
import { Budget } from "@/budget"
import { BudgetPeriod } from "@/budget/period"
import { BudgetSpend } from "@/budget/spend"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// XCOD-298: `lunos budget`: where each project's budget stands, setting one, and a CSV of a period's
// spend for invoicing. A project's budget is kept on this computer with the project; the
// organisation's comes from managed config and can't be changed here.

const out = (line = "") => process.stdout.write(line + EOL)
const dim = (text: string) => UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL

type Target = { id: string; name: string; directory: string; project?: ProjectGroup.Repository }

/** `--project`: a named project (name or id), or this folder's project when left out or ".". */
const target = Effect.fn("Cli.budget.target")(function* (name: string | undefined) {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* fail("No project here")
  const project = { id: ctx.project.id, worktree: ctx.project.worktree, name: ctx.project.name }
  if (name && name !== ".") {
    const group = yield* Effect.promise(() => ProjectGroup.get(name))
    if (group) return { id: group.id, name: group.name, directory: group.folders[0] ?? ctx.directory } as Target
    // A repository project by its id.
    if (name === project.id) {
      const own = ProjectGroup.implicit(ctx.directory, project)
      return { id: own.id, name: own.name, directory: ctx.directory, project } as Target
    }
    return yield* fail(`No project "${name}". See lunos project list`)
  }
  const here = (yield* Effect.promise(() => ProjectGroup.resolve(ctx.directory, project)))!
  return { id: here.id, name: here.name, directory: ctx.directory, project } as Target
})

const describe = (item: Budget.Status) => {
  const lines = [
    `${item.project.name}${item.locked ? " 🔒 set by your organisation" : ""}: ${Budget.money(item.spent, item.currency)} of ${Budget.money(item.amount, item.currency)} (${item.period.label}), ${Math.round(item.percent)}%`,
    dim(`  ${Budget.left(item)} · at the limit: ${item.on_limit}`),
  ]
  if (item.forecast !== undefined)
    lines.push(dim(`  forecast for the period: ${Budget.money(item.forecast, item.currency)}`))
  if (item.today)
    lines.push(
      dim(
        `  today: ${Budget.money(item.today.spent, item.currency)} of ${Budget.money(item.today.cap, item.currency)}`,
      ),
    )
  if (item.unknown)
    lines.push(
      `  + ${item.unknown} turn${item.unknown === 1 ? "" : "s"} of unknown cost: set a price with provider.<id>.models.<id>.cost`,
    )
  return lines
}

export const BudgetStatusCommand = effectCmd({
  command: "status",
  describe: "where this project's budget (and your organisation's) stands",
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", describe: "a named project (name or id); default: this folder's" })
      .option("json", { type: "boolean", default: false, describe: "print JSON" }),
  handler: Effect.fn("Cli.budget.status")(function* (args) {
    const where = yield* target(args.project)
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const list = yield* Budget.status({ directory: where.directory, project: where.project }, config as Budget.Config, {
      fresh: true,
    })
    if (args.json) {
      out(JSON.stringify({ project: { id: where.id, name: where.name }, budgets: list }, null, 2))
      return
    }
    if (!list.length) {
      out(`${where.name} has no budget.`)
      out(dim(`Set one with lunos budget set "${where.name}" 50`))
      return
    }
    for (const item of list) for (const line of describe(item)) out(line)
  }),
})

export const BudgetSetCommand = effectCmd({
  command: "set [project] [amount]",
  describe: "set (or with --clear remove) a project's budget, kept on this computer",
  builder: (yargs) =>
    yargs
      .positional("project", { type: "string", describe: 'a named project (name or id), or "." for this folder\'s' })
      .positional("amount", { type: "number", describe: "the amount for each period, in budget.currency" })
      .option("period", { type: "string", choices: ConfigBudget.PERIODS as unknown as string[], default: "monthly" })
      .option("reset-day", { type: "number", describe: "with --period monthly: the day it resets on, 1 to 28" })
      .option("per-session", { type: "number", describe: "most one session may spend, subagents included" })
      .option("per-day", { type: "number", describe: "most the project may spend in a day" })
      .option("on-limit", { type: "string", choices: ConfigBudget.LIMIT_ACTIONS as unknown as string[] })
      .option("clear", { type: "boolean", default: false, describe: "remove the budget" })
      .option("json", { type: "boolean", default: false, describe: "print JSON" }),
  handler: Effect.fn("Cli.budget.set")(function* (args) {
    const where = yield* target(args.project)
    if (args.clear) {
      yield* Effect.promise(() => ProjectGroup.setBudget(where.id, null))
      if (args.json) out(JSON.stringify({ project: { id: where.id, name: where.name }, budget: null }, null, 2))
      else out(`${where.name} has no budget now.`)
      return
    }
    const amount = Number(args.amount)
    if (!(amount > 0)) return yield* fail("Give the amount, e.g. lunos budget set . 50")
    const reset = args["reset-day"]
    if (reset !== undefined && !(Number.isInteger(reset) && reset >= 1 && reset <= 28))
      return yield* fail("--reset-day is a day of the month, 1 to 28")
    const budget: ConfigBudget.Budget = {
      amount,
      period: args.period as ConfigBudget.Period,
      ...(reset !== undefined ? { reset_day: reset } : {}),
      ...(args["per-session"] ? { per_session: args["per-session"] } : {}),
      ...(args["per-day"] ? { per_day: args["per-day"] } : {}),
      ...(args["on-limit"] ? { on_limit: args["on-limit"] as ConfigBudget.LimitAction } : {}),
    }
    const saved = yield* Effect.tryPromise(() => ProjectGroup.setBudget(where.id, budget)).pipe(
      Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
    )
    if (args.json) out(JSON.stringify({ project: { id: where.id, name: where.name }, budget: saved }, null, 2))
    else {
      const config = yield* Config.Service.use((cfg) => cfg.get())
      const currency = Budget.settings(config as Budget.Config).currency
      out(
        `${where.name}: ${Budget.money(amount, currency)} ${budget.period === "total" ? "in total" : `a ${budget.period === "weekly" ? "week" : "month"}`}`,
      )
    }
  }),
})

const csv = (value: string | number | boolean | undefined) => {
  const text = value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const BudgetExportCommand = effectCmd({
  command: "export",
  describe: "a CSV of a period's spend, turn by turn, for invoicing",
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", describe: "a named project (name or id); default: this folder's" })
      .option("period", {
        type: "string",
        describe:
          'the period: "2026-10" (a month), "2026-10-15" (a month from that day) or "total"; default: the current one',
      })
      .option("output", { type: "string", alias: "o", describe: "write to this file instead of the terminal" }),
  handler: Effect.fn("Cli.budget.export")(function* (args) {
    const where = yield* target(args.project)
    const config = (yield* Config.Service.use((cfg) => cfg.get())) as Budget.Config
    const set = Budget.settings(config)
    const own = (yield* Effect.promise(() => ProjectGroup.snapshot())).budgets[where.id] ?? { amount: 1 }
    const period = args.period ? BudgetPeriod.parse(own, args.period) : BudgetPeriod.of(own)
    if (!period) return yield* fail(`Not a period: ${args.period}. Use 2026-10, 2026-10-15 or total`)
    const turns = (yield* BudgetSpend.turns(period.start, period.end)).filter((turn) => turn.project === where.id)
    const rows = [
      [
        "time",
        "project",
        "session",
        "title",
        "subagent",
        "model",
        "agent",
        `cost_${set.currency.toLowerCase()}`,
        "cost_usd",
        "unknown_cost",
      ],
      ...turns.map((turn) => [
        new Date(turn.time).toISOString(),
        where.name,
        turn.session,
        turn.title,
        turn.subagent,
        turn.model,
        turn.agent,
        (turn.cost * set.rate).toFixed(6),
        turn.cost.toFixed(6),
        turn.unknown,
      ]),
    ]
    const text = rows.map((row) => row.map(csv).join(",")).join("\n") + "\n"
    if (args.output) {
      yield* Effect.promise(() => fs.writeFile(args.output!, text))
      out(`${turns.length} turns of ${where.name} (${period.label}) written to ${args.output}`)
    } else process.stdout.write(text)
  }),
})

export const BudgetCommand = cmd({
  command: "budget",
  describe: "project budgets: status, set, and a CSV export for a period",
  builder: (yargs) =>
    yargs.command(BudgetStatusCommand).command(BudgetSetCommand).command(BudgetExportCommand).demandCommand(),
  async handler() {},
})
