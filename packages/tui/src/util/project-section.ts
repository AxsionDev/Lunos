import type { BudgetStatusItem, ProjectGroup, ResourceItem, SettingRow } from "@opencode-ai/sdk/v2"
import type { ProjectRef } from "./project-theme"

/**
 * XCOD-306: the sidebar's Project section and the project's own settings. Pure, so the header, the
 * collapsed line, the warning glyph, each group's rows and which keys a project can set are tested
 * without a terminal.
 */

/** Where the section's open/closed choice is kept (kv.json). */
export const OPEN_KEY = "sidebar_project_open"

/** The session's project, from the budget status (it follows moved sessions) and the named projects. */
export function projectRef(
  status: { project: { id: string; name: string } } | undefined,
  groups: readonly Pick<ProjectGroup, "id" | "implicit" | "archived">[],
): ProjectRef | undefined {
  if (!status) return undefined
  const named = groups.some((group) => group.id === status.project.id && !group.implicit)
  return { key: status.project.id, name: status.project.name, kind: named ? "named" : "repository" }
}

/** "Project · Axsion web", or "Repository: axsion-web" when it has no named project. */
export function header(ref: ProjectRef) {
  return ref.kind === "named" ? `Project · ${ref.name}` : `Repository: ${ref.name}`
}

const sign = (currency: string) => (currency === "EUR" ? "€" : "$")
const money = (value: number, currency: string) =>
  `${sign(currency)}${Number.isInteger(value) ? value : value.toFixed(2)}`

/** The budget the collapsed line shows: the most used one. */
export function headline(budgets: readonly BudgetStatusItem[]) {
  return budgets.toSorted((a, b) => b.percent - a.percent)[0]
}

/** "€38 of €50 · Oct". */
export function budgetLine(item: Pick<BudgetStatusItem, "spent" | "amount" | "currency" | "period">) {
  const spent = Math.round(item.spent * 100) / 100
  return `${money(spent, item.currency)} of ${money(item.amount, item.currency)} · ${item.period.label}`
}

/** The budget meter's warning colour starts here; the glyph uses the same line. */
export const BUDGET_WARN = 80

/** Why the section shows ⚠: a budget past the warning line, or a resource that failed to index. */
export function warnings(input: { budgets: readonly BudgetStatusItem[]; resources: readonly ResourceItem[] }) {
  const result: string[] = []
  for (const item of input.budgets)
    if (item.percent >= BUDGET_WARN) result.push(`${item.name} budget at ${Math.round(item.percent)}%`)
  const failed = input.resources.filter((item) => item.problem || item.error)
  if (failed.length) result.push(`${failed.length} ${failed.length === 1 ? "resource" : "resources"} failed to index`)
  return result
}

const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))

/** "3 always · 5 search · 2 on demand · 6.1k tokens · 1 failed". */
export function resources(list: readonly ResourceItem[]) {
  if (!list.length) return "none"
  const count = (mode: ResourceItem["mode"]) => list.filter((item) => item.mode === mode).length
  const failed = list.filter((item) => item.problem || item.error).length
  const total = list.reduce((sum, item) => sum + (item.mode === "always" ? (item.tokens ?? 0) : 0), 0)
  return [
    count("always") ? `${count("always")} always` : "",
    count("search") ? `${count("search")} search` : "",
    count("on_demand") ? `${count("on_demand")} on demand` : "",
    total ? `${tokens(total)} tokens` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

export type Row = { label: string; value: string; warn?: boolean; open?: string }
export type Group = { title: string; rows: Row[] }

type Value = Pick<SettingRow, "key" | "display" | "source" | "locked" | "value">

const LIMIT: Record<string, string> = { warn: "warn and run", ask: "ask", stop: "stop" }

/**
 * Everything defined for the project, read-only, in the ticket's order. Groups with nothing to show
 * are left out; `open` names the detail a row opens.
 */
export function groups(input: {
  ref: ProjectRef
  group?: Pick<ProjectGroup, "folders" | "time">
  directory: string
  budgets: readonly BudgetStatusItem[]
  resources: readonly ResourceItem[]
  rows: readonly Value[]
  sandbox?: string
  theme?: { name: string; source: string }
  short?: (folder: string) => string
}): Group[] {
  const short = input.short ?? ((folder: string) => folder)
  const row = (key: string) => input.rows.find((item) => item.key === key)
  const set = (key: string) => {
    const item = row(key)
    return item && item.source !== "default" ? item.display : undefined
  }
  const out: Group[] = []

  const about: Row[] = [
    { label: "name", value: input.ref.name, open: "project" },
    { label: "kind", value: input.ref.kind === "named" ? "named project, on this computer" : "repository" },
  ]
  if (input.group?.time.created)
    about.push({ label: "created", value: new Date(input.group.time.created).toISOString().slice(0, 10) })
  out.push({ title: "About", rows: about })

  const folders = input.group?.folders ?? []
  if (folders.length)
    out.push({
      title: "Folders",
      rows: folders.map((folder) => ({
        label: input.directory === folder || input.directory.startsWith(folder + "/") ? "●" : " ",
        value: short(folder),
        open: "project",
      })),
    })

  if (input.budgets.length)
    out.push({
      title: "Budget",
      rows: input.budgets.flatMap((item) => [
        {
          label: item.scope === "organisation" ? "🔒 organisation" : "spent",
          value: `${budgetLine(item)} (${Math.round(item.percent)}%)`,
          warn: item.percent >= BUDGET_WARN,
          open: "budget",
        },
        {
          label: "remaining",
          value: `${money(Math.max(0, Math.round(item.remaining * 100) / 100), item.currency)}${
            item.forecast !== undefined ? ` · forecast ${money(Math.round(item.forecast), item.currency)}` : ""
          }`,
          open: "budget",
        },
        { label: "at the limit", value: LIMIT[item.on_limit] ?? item.on_limit, open: "budget" },
      ]),
    })

  out.push({
    title: "Resources",
    rows: [
      {
        label: "in use",
        value: resources(input.resources),
        warn: input.resources.some((item) => item.problem || item.error),
        open: "resources",
      },
    ],
  })

  out.push({
    title: "Agent defaults",
    rows: [
      { label: "agent", value: set("default_agent") ?? "build", open: "settings" },
      { label: "model", value: set("model") ?? "not set", open: "settings" },
      { label: "parallel subagents", value: row("subagent.max_parallel")?.display ?? "3", open: "settings" },
      { label: "verification", value: set("verify") ? "on" : "off", open: "settings" },
    ],
  })

  const memory = row("memory.enabled")
  out.push({
    title: "Memory",
    rows: [
      { label: "memory", value: memory?.value === true ? "on" : "off", open: "memory" },
      ...(set("memory.backend.type") ? [{ label: "storage", value: set("memory.backend.type")!, open: "memory" }] : []),
      {
        label: "project scope",
        // Unset, memory is kept in the project (`memory.scope` defaults to ["project"]).
        value: !set("memory.scope") || set("memory.scope")!.includes("project") ? "on" : "off",
        open: "memory",
      },
    ],
  })

  if (input.sandbox) out.push({ title: "Sandbox", rows: [{ label: "sandbox", value: input.sandbox, open: "sandbox" }] })

  const locked = input.rows.filter((item) => item.locked)
  if (locked.length)
    out.push({
      title: "Policy",
      rows: locked.map((item) => ({ label: "🔒", value: `${item.key} = ${item.display}`, open: "settings" })),
    })

  if (input.theme)
    out.push({ title: "Theme", rows: [{ label: input.theme.source, value: input.theme.name, open: "theme" }] })
  return out
}

/**
 * The keys Settings › Project offers: what a project can set for itself. Everything else (your
 * account, providers, updates, the TUI's look apart from the theme) stays in your own settings.
 */
const PROJECT_PREFIXES = [
  "model",
  "small_model",
  "default_agent",
  "agent",
  "subagent",
  "verify",
  "memory.scope",
  "memory.template",
  "memory.enabled",
  "sandbox",
  "instructions",
  "mcp",
  "budget.on_limit",
  "budget.thresholds",
  "budget.currency",
  "tui.theme",
]

export function projectScoped(key: string) {
  return PROJECT_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
}

/**
 * Keys a repository's config can't set at all because they'd weaken the sandbox: offered as yours
 * only, with why. The server refuses them in project config for the same reasons (settings.ts
 * USER_ONLY); its value-dependent ones (workspace, devcontainer, network) stay shared, and a value
 * a repository can't choose is refused there with the reason.
 */
const PERSONAL_ONLY: Record<string, string> = {
  "sandbox.allow": "extra hosts for the sandbox's network are yours to allow, not a repository's",
  "sandbox.mounts": "mounting directories from this machine is yours to choose, not a repository's",
}

export function personalOnly(key: string) {
  return Object.entries(PERSONAL_ONLY).find(([entry]) => key === entry || key.startsWith(`${entry}.`))?.[1]
}
