import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2"

/**
 * XCOD-205: the model behind the TUI's /sessions view. Pure, so grouping, filtering and collapsing
 * are tested without a terminal. Same ordering as the desktop/web Sessions window: groups in
 * creation order, then Ungrouped; newest first inside each; subagents under their parent.
 *
 * The TUI shows one flat, keyboard-navigable list, so a group header is a row of its own (Enter
 * collapses or expands it) and a subagent is a row indented under its parent.
 */

export type SessionState = SessionOverviewItem["state"]
export type StateFilter = SessionState | "all"

export type Line =
  | {
      type: "group"
      /** "group:<id>", or UNGROUPED_KEY. */
      key: string
      /** null is "Ungrouped". */
      group: SessionGroup | null
      count: number
      collapsed: boolean
    }
  | {
      type: "session"
      key: string
      item: SessionOverviewItem
      /** 1 for a subagent shown under its parent. */
      depth: 0 | 1
      groupID: string | null
    }

export const UNGROUPED_KEY = "group:ungrouped"
export const groupKey = (id: string) => `group:${id}`

// XCOD-141: every state has its own glyph as well as its colour, so it never relies on colour alone.
export const STATE_GLYPH: Record<SessionState, string> = {
  waiting: "!",
  running: "»",
  idle: "○",
  finished: "✓",
  failed: "✕",
}

export const STATE_LABEL: Record<SessionState, string> = {
  waiting: "waiting for approval",
  running: "running",
  idle: "idle",
  finished: "finished",
  failed: "failed",
}

/** The state filter cycles through these, "all" first. Waiting first: it is what needs you. */
export const STATE_FILTERS: StateFilter[] = ["all", "waiting", "running", "idle", "finished", "failed"]

export function nextStateFilter(current: StateFilter): StateFilter {
  const index = STATE_FILTERS.indexOf(current)
  return STATE_FILTERS[(index + 1) % STATE_FILTERS.length]!
}

export function stateLabel(item: Pick<SessionOverviewItem, "state" | "elsewhere" | "stale">) {
  // XCOD-234: the Lunos that ran it stopped without finishing the turn.
  if (item.stale) return "not responding (its Lunos closed)"
  if (item.elsewhere) return item.state === "waiting" ? "waiting in another Lunos" : "running in another Lunos"
  return STATE_LABEL[item.state]
}

/** "subagent", "scheduled", "external (claude)"; nothing for an ordinary session. */
export function kindLabel(item: Pick<SessionOverviewItem, "kind" | "tool">) {
  if (item.kind === "external") return item.tool ? `external (${item.tool})` : "external"
  if (item.kind === "session") return undefined
  return item.kind
}

export function projectName(item: Pick<SessionOverviewItem, "project" | "directory">) {
  if (item.project?.name) return item.project.name
  // Folders that aren't a git repo with commits share the "global" project: the folder says more.
  const path = item.project && item.project.id !== "global" ? item.project.worktree : item.directory
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Compact relative time for a narrow column: "now", "5m ago", "3h ago", "2d ago". */
export function ago(time: number, now: number) {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

export function money(cost: number) {
  if (!cost) return "$0.00"
  if (cost < 0.01) return "<$0.01"
  return `$${cost.toFixed(2)}`
}

/**
 * A Claude Code / Codex session Lunos started that has no Lunos session of its own (from `lunos
 * external` or the external tool): only its tool can open it. One started with /external (XCOD-218)
 * is a Lunos session labelled external, and opens, renames and stops like any other.
 */
export function toolOnly(item: Pick<SessionOverviewItem, "id">) {
  return item.id.startsWith("external:")
}

/**
 * Whether a row can be stopped from here: a Lunos session this Lunos is running or waiting on.
 * Tool-only sessions run in their own process; "elsewhere" ones are stopped by the Lunos that runs them.
 */
export function stoppable(item: Pick<SessionOverviewItem, "id" | "state" | "elsewhere" | "stale">) {
  // XCOD-234: a running Claude Code / Codex session stops like `lunos external stop`.
  if (toolOnly(item)) return item.state === "running"
  // XCOD-234: a session another Lunos runs is stopped by that Lunos.
  return item.state === "running" || item.state === "waiting"
}

function matches(item: SessionOverviewItem, search: string, state: StateFilter, groupName: string | undefined) {
  if (state !== "all" && item.state !== state) return false
  if (!search) return true
  return [
    item.title,
    projectName(item),
    item.directory,
    item.state,
    stateLabel(item),
    kindLabel(item),
    item.agent,
    item.model,
    groupName,
  ]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(search))
}

export function build(input: {
  groups: SessionGroup[]
  sessions: SessionOverviewItem[]
  search: string
  state: StateFilter
  /** Whether Ungrouped is collapsed. It isn't a stored group, so this view keeps it. */
  ungroupedCollapsed?: boolean
}): Line[] {
  const search = input.search.trim().toLowerCase()
  const filtering = !!search || input.state !== "all"
  const known = new Map(input.groups.map((group) => [group.id, group]))
  const ids = new Set(input.sessions.map((item) => item.id))

  // A subagent sits under its parent when the parent is listed; otherwise it is a row of its own.
  const children = new Map<string, SessionOverviewItem[]>()
  for (const item of input.sessions) {
    if (!item.parentID || !ids.has(item.parentID)) continue
    const list = children.get(item.parentID) ?? []
    list.push(item)
    children.set(item.parentID, list)
  }
  const newest = (a: SessionOverviewItem, b: SessionOverviewItem) => b.updated - a.updated

  // Rows per group id ("" is Ungrouped). A session whose group is gone reads as Ungrouped.
  const rows = new Map<string, { item: SessionOverviewItem; kids: SessionOverviewItem[] }[]>()
  for (const item of input.sessions) {
    if (item.parentID && ids.has(item.parentID)) continue
    const groupID = item.groupID && known.has(item.groupID) ? item.groupID : ""
    const name = groupID ? known.get(groupID)!.name : undefined
    const kids = (children.get(item.id) ?? []).toSorted(newest)
    const own = matches(item, search, input.state, name)
    const shown = own ? kids : kids.filter((kid) => matches(kid, search, input.state, name))
    if (!own && shown.length === 0) continue
    const list = rows.get(groupID) ?? []
    list.push({ item, kids: shown })
    rows.set(groupID, list)
  }

  const lines: Line[] = []
  const section = (group: SessionGroup | null) => {
    const id = group?.id ?? ""
    const list = (rows.get(id) ?? []).toSorted((a, b) => newest(a.item, b.item))
    // While filtering, a section without a match is noise. Otherwise an empty group stays visible,
    // so it can be moved into; an empty Ungrouped is left out.
    if (list.length === 0 && (filtering || !group)) return
    const collapsed = group ? group.collapsed : input.ungroupedCollapsed === true
    lines.push({ type: "group", key: group ? groupKey(group.id) : UNGROUPED_KEY, group, count: list.length, collapsed })
    // A search never hides a hit, so filtering shows matches inside collapsed groups too.
    if (collapsed && !filtering) return
    for (const row of list) {
      lines.push({ type: "session", key: row.item.id, item: row.item, depth: 0, groupID: group?.id ?? null })
      for (const kid of row.kids)
        lines.push({ type: "session", key: kid.id, item: kid, depth: 1, groupID: group?.id ?? null })
    }
  }
  for (const group of input.groups) section(group)
  section(null)
  return lines
}

/** Sessions needing an answer, for the title. */
export function waiting(sessions: Pick<SessionOverviewItem, "state">[]) {
  return sessions.filter((item) => item.state === "waiting").length
}
