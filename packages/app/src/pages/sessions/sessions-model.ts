import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2/client"

/**
 * XCOD-205: the Sessions window's view model. Pure, so filtering and grouping are tested without a
 * DOM: groups in creation order, then "Ungrouped"; subagents under their parent; newest first.
 */

export type SessionState = SessionOverviewItem["state"]
/** XCOD-265: "archived" is the "Show archived" view: the sessions Clear list hid, and nothing else. */
export type StateFilter = SessionState | "all" | "archived"

export type Row = { item: SessionOverviewItem; children: SessionOverviewItem[] }

export type Section = {
  /** null is "Ungrouped". */
  group: SessionGroup | null
  rows: Row[]
  count: number
}

export type Filter = {
  search: string
  state: StateFilter
  /** A group id, "ungrouped", or "all". */
  group: string
}

export const UNGROUPED = "ungrouped"

export function projectName(item: SessionOverviewItem) {
  if (item.project?.name) return item.project.name
  const path = item.project?.worktree ?? item.directory
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function matches(item: SessionOverviewItem, filter: Filter, groupName: string | undefined) {
  // The archived view lists archived sessions whatever their state.
  if (filter.state !== "all" && filter.state !== "archived" && item.state !== filter.state) return false
  const query = filter.search.trim().toLowerCase()
  if (!query) return true
  return [item.title, projectName(item), item.directory, item.state, item.agent, item.model, groupName]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(query))
}

export function build(input: { groups: SessionGroup[]; sessions: SessionOverviewItem[]; filter: Filter }): Section[] {
  const known = new Set(input.groups.map((group) => group.id))
  const names = new Map(input.groups.map((group) => [group.id, group.name]))
  const ids = new Set(input.sessions.map((item) => item.id))
  const groupOf = (item: SessionOverviewItem) => (item.groupID && known.has(item.groupID) ? item.groupID : undefined)

  // A subagent sits under its parent when the parent is listed; otherwise it is a row of its own.
  const children = new Map<string, SessionOverviewItem[]>()
  for (const item of input.sessions) {
    if (!item.parentID || !ids.has(item.parentID)) continue
    const list = children.get(item.parentID) ?? []
    list.push(item)
    children.set(item.parentID, list)
  }
  const tops = input.sessions.filter((item) => !item.parentID || !ids.has(item.parentID))

  const rows = new Map<string | null, Row[]>()
  for (const item of tops) {
    const group = groupOf(item) ?? null
    if (input.filter.group !== "all") {
      if (input.filter.group === UNGROUPED ? group !== null : group !== input.filter.group) continue
    }
    const kids = children.get(item.id) ?? []
    const name = group ? names.get(group) : undefined
    const own = matches(item, input.filter, name)
    const shown = kids.filter((kid) => matches(kid, input.filter, name))
    if (!own && shown.length === 0) continue
    const list = rows.get(group) ?? []
    list.push({ item, children: own ? kids : shown })
    rows.set(group, list)
  }

  const order = (a: Row, b: Row) => b.item.updated - a.item.updated
  const sections: Section[] = input.groups
    .filter((group) => input.filter.group === "all" || input.filter.group === group.id)
    .map((group) => {
      const list = (rows.get(group.id) ?? []).toSorted(order)
      return { group, rows: list, count: list.length }
    })
  if (input.filter.group === "all" || input.filter.group === UNGROUPED) {
    const list = (rows.get(null) ?? []).toSorted(order)
    sections.push({ group: null, rows: list, count: list.length })
  }
  return sections
}

/** Sessions needing an answer, for the header badge. */
export function waiting(sessions: SessionOverviewItem[]) {
  return sessions.filter((item) => item.state === "waiting").length
}

export const STATE_ORDER: SessionState[] = ["waiting", "running", "idle", "finished", "failed"]

export const GROUP_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#6b7280"]

/** The smallest cost the window shows as a number; anything above zero but below it reads "<$0.0001". */
const SMALLEST = 0.0001

/** A session's cost in USD, up to 4 decimals. A cost too small to round to a cent fraction isn't "$0.00" (XCOD-235). */
export function money(value: number, locale?: string) {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 })
  if (value > 0 && value < SMALLEST) return `<${format.format(SMALLEST)}`
  return format.format(value)
}

/**
 * XCOD-265: the sessions in the current view, for Stop all and Clear list: those matching the state
 * filter, the search and the group filter, whether or not their group is collapsed. A subagent counts
 * on its own (with the filter on "waiting", only waiting sessions are in view), in its parent's group.
 * Same rule as /sessions in the TUI; the plans below are counted the way its confirmations say them.
 */
export function inView(input: { groups: SessionGroup[]; sessions: SessionOverviewItem[]; filter: Filter }) {
  const names = new Map(input.groups.map((group) => [group.id, group.name]))
  const byID = new Map(input.sessions.map((item) => [item.id, item]))
  return input.sessions.filter((item) => {
    const top = item.parentID ? (byID.get(item.parentID) ?? item) : item
    const group = top.groupID && names.has(top.groupID) ? top.groupID : undefined
    if (input.filter.group !== "all") {
      if (input.filter.group === UNGROUPED ? group !== undefined : group !== input.filter.group) return false
    }
    return matches(item, input.filter, group ? names.get(group) : undefined)
  })
}

/** An "external:" row: a Claude Code / Codex session with no Lunos session of its own. */
export const toolOnly = (item: Pick<SessionOverviewItem, "id">) => item.id.startsWith("external:")

/** Same rule as the per-row Stop and the server: a running external tool, or a Lunos session running or waiting. */
export function stoppable(item: Pick<SessionOverviewItem, "id" | "state">) {
  if (toolOnly(item)) return item.state === "running"
  return item.state === "running" || item.state === "waiting"
}

/** What Clear list archives: anything not running or waiting for an answer. */
export function clearable(item: Pick<SessionOverviewItem, "state">) {
  return item.state === "finished" || item.state === "idle" || item.state === "failed"
}

/**
 * A subagent whose parent is in the list goes with its parent (archived, restored and deleted
 * together), so it isn't counted or sent on its own.
 */
export function topLevel<T extends Pick<SessionOverviewItem, "id" | "parentID">>(items: T[]) {
  const ids = new Set(items.map((item) => item.id))
  return items.filter((item) => !item.parentID || !ids.has(item.parentID))
}

const TOOL_NAMES: Record<string, string> = { claude: "Claude Code", "claude-code": "Claude Code", codex: "Codex" }

/** "Claude Code", "Codex", or the tool's own id; undefined when the row doesn't say which tool. */
export function toolName(item: Pick<SessionOverviewItem, "tool">) {
  return item.tool ? (TOOL_NAMES[item.tool] ?? item.tool) : undefined
}

/**
 * The project a row belongs to, for "Stop all" in one project only: its worktree, so a Claude Code /
 * Codex row (which only has its folder) lands with the Lunos sessions of the same project. Folders
 * that aren't a git repo share the "global" project; there the folder is the project.
 */
export const projectKey = (item: SessionOverviewItem) =>
  item.project && item.project.id !== "global" ? item.project.worktree : item.directory

/** XCOD-265: what Stop all would stop, by kind, for its confirmation. */
export function stopPlan(items: SessionOverviewItem[]) {
  const targets = items.filter((item) => stoppable(item))
  const tools = new Map<string | undefined, number>()
  let running = 0
  let waitingCount = 0
  for (const item of targets) {
    if (item.kind === "external") {
      const name = toolName(item)
      tools.set(name, (tools.get(name) ?? 0) + 1)
      continue
    }
    if (item.state === "waiting") waitingCount++
    else running++
  }
  const projects = new Map<string, { key: string; name: string; count: number }>()
  for (const item of targets) {
    const key = projectKey(item)
    const name = item.project?.name ?? key.split(/[\\/]/).filter(Boolean).pop() ?? key
    const entry = projects.get(key) ?? { key, name, count: 0 }
    entry.count++
    projects.set(key, entry)
  }
  return {
    targets,
    running,
    waiting: waitingCount,
    tools: [...tools].map(([name, count]) => ({ name, count })),
    elsewhere: targets.filter((item) => item.elsewhere).length,
    projects: [...projects.values()],
  }
}

/** XCOD-265: what Clear list would archive, and what stays because it's running or waiting. */
export function clearPlan(items: SessionOverviewItem[]) {
  return {
    targets: topLevel(items.filter((item) => clearable(item))),
    staying: items.filter((item) => !clearable(item)),
  }
}
