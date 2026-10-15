import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2/client"

/**
 * XCOD-205: the Sessions window's view model. Pure, so filtering and grouping are tested without a
 * DOM: groups in creation order, then "Ungrouped"; subagents under their parent; newest first.
 */

export type SessionState = SessionOverviewItem["state"]
export type StateFilter = SessionState | "all"

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
  if (filter.state !== "all" && item.state !== filter.state) return false
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
