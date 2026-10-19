import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { EXTERNAL_BADGE } from "./external"

const EXTERNAL_TOOL_NAMES: Record<string, string> = { ...EXTERNAL_BADGE, "claude-code": EXTERNAL_BADGE.claude }

/**
 * XCOD-205: the model behind the TUI's /sessions view. Pure, so grouping, filtering and collapsing
 * are tested without a terminal. Same ordering as the desktop/web Sessions window: groups in
 * creation order, then Ungrouped; newest first inside each; subagents under their parent.
 *
 * The TUI shows one flat, keyboard-navigable list, so a group header is a row of its own (Enter
 * collapses or expands it) and a subagent is a row indented under its parent.
 */

export type SessionState = SessionOverviewItem["state"]
/** XCOD-265: "archived" is the "Show archived" view: the sessions Clear list hid, and nothing else. */
export type StateFilter = SessionState | "all" | "archived"

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

/** The state filter cycles through these, "all" first. Waiting first: it is what needs you. Archived last. */
export const STATE_FILTERS: StateFilter[] = ["all", "waiting", "running", "idle", "finished", "failed", "archived"]

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

/** "subagent", "scheduled", "Claude Code", "Codex"; nothing for an ordinary session. */
export function kindLabel(item: Pick<SessionOverviewItem, "kind" | "tool">) {
  // XCOD-260: an external session is named by its tool, as the session's own badge names it.
  if (item.kind === "external")
    return EXTERNAL_TOOL_NAMES[item.tool ?? ""] ?? (item.tool ? `external (${item.tool})` : "external")
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
  // The archived view lists archived sessions whatever their state.
  if (state !== "all" && state !== "archived" && item.state !== state) return false
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

/**
 * XCOD-265: whether a session belongs in the session list, the quick-switch slots and `--continue`:
 * one cleared from /sessions (archived) doesn't, though it is still on disk and opens by id.
 */
export function listed(session: { time: { archived?: number | null } }) {
  return !session.time.archived
}

/** Sessions needing an answer, for the title. */
export function waiting(sessions: Pick<SessionOverviewItem, "state">[]) {
  return sessions.filter((item) => item.state === "waiting").length
}

/**
 * XCOD-265: the sessions in the current view, for Stop all and Clear list: those matching the state
 * filter and the search (which also matches group names), whether or not their group is collapsed.
 * A subagent counts on its own: with the filter on "waiting", only waiting sessions are in view.
 */
export function inView(input: {
  groups: SessionGroup[]
  sessions: SessionOverviewItem[]
  search: string
  state: StateFilter
}) {
  const search = input.search.trim().toLowerCase()
  const known = new Map(input.groups.map((group) => [group.id, group]))
  const byID = new Map(input.sessions.map((item) => [item.id, item]))
  return input.sessions.filter((item) => {
    // A subagent listed under its parent is in the parent's group, as build() shows it.
    const top = item.parentID ? (byID.get(item.parentID) ?? item) : item
    const name = top.groupID ? known.get(top.groupID)?.name : undefined
    return matches(item, search, input.state, name)
  })
}

/** What clearing the list archives: anything not running or waiting for an answer. */
export function clearable(item: Pick<SessionOverviewItem, "state">) {
  return item.state === "finished" || item.state === "idle" || item.state === "failed"
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** XCOD-265: what Stop all would stop, counted the way its confirmation says it. */
export function stopPlan(items: SessionOverviewItem[]) {
  const targets = items.filter((item) => stoppable(item))
  const tools = new Map<string, number>()
  let running = 0
  let waitingCount = 0
  for (const item of targets) {
    if (item.kind === "external") {
      const name = kindLabel(item) ?? "external"
      tools.set(name, (tools.get(name) ?? 0) + 1)
      continue
    }
    if (item.state === "waiting") waitingCount++
    else running++
  }
  return {
    targets,
    running,
    waiting: waitingCount,
    tools: [...tools],
    elsewhere: targets.filter((item) => item.elsewhere).length,
    projects: [...new Set(targets.map((item) => projectName(item)))],
  }
}

/** "4 running, 2 waiting for an answer, 1 Claude Code" */
function stopBreakdown(plan: ReturnType<typeof stopPlan>) {
  return [
    plan.running ? `${plan.running} running` : undefined,
    plan.waiting ? `${plan.waiting} waiting for an answer` : undefined,
    ...plan.tools.map(([name, count]) => `${count} ${name}`),
  ]
    .filter(Boolean)
    .join(", ")
}

/** "Stop 7 sessions? 4 running, 2 waiting for an answer, 1 Claude Code. 2 of them run in another Lunos window." */
export function stopQuestion(plan: ReturnType<typeof stopPlan>) {
  const total = plan.targets.length
  const elsewhere = plan.elsewhere
    ? ` ${plan.elsewhere} of them ${plan.elsewhere === 1 ? "runs" : "run"} in another Lunos window.`
    : ""
  return `Stop ${plural(total, "session")}? ${stopBreakdown(plan)}.${elsewhere}`
}

/**
 * A subagent whose parent is in the list goes with its parent (archived, restored and deleted
 * together), so it isn't counted or sent on its own.
 */
export function topLevel<T extends Pick<SessionOverviewItem, "id" | "parentID">>(items: T[]) {
  const ids = new Set(items.map((item) => item.id))
  return items.filter((item) => !item.parentID || !ids.has(item.parentID))
}

/** XCOD-265: what Clear list would archive, and what stays because it's running or waiting. */
export function clearPlan(items: SessionOverviewItem[]) {
  return {
    targets: topLevel(items.filter((item) => clearable(item))),
    staying: items.filter((item) => !clearable(item)),
  }
}

/** "Clear 4 sessions from the list? … 3 running sessions stay; stop them first, or use Stop all & clear." */
export function clearQuestion(plan: ReturnType<typeof clearPlan>) {
  const stays = plan.staying.length
    ? ` ${plural(plan.staying.length, "running session")} ${plan.staying.length === 1 ? "stays" : "stay"}; stop ${plan.staying.length === 1 ? "it" : "them"} first, or use Stop all & clear.`
    : ""
  return `Clear ${plural(plan.targets.length, "session")} from the list? They're archived, not deleted: Show archived brings them back.${stays}`
}

/** "Stop 3 sessions and clear 7 from the list? 1. Stop: … 2. Clear: …" */
export function stopAndClearQuestion(items: SessionOverviewItem[]) {
  const stop = stopPlan(items)
  const clear = clearPlan(items)
  const total = stop.targets.length + clear.targets.length
  const elsewhere = stop.elsewhere ? ` (${stop.elsewhere} in another Lunos window)` : ""
  return (
    `Stop ${plural(stop.targets.length, "session")} and clear ${total} from the list? ` +
    `1. Stop ${stopBreakdown(stop) || "nothing"}${elsewhere}. ` +
    `2. Archive all ${total}: they're hidden, not deleted, and Show archived brings them back.`
  )
}

/** "Stopped 7 · 1 couldn't be stopped (another Lunos didn't respond)" */
export function stopSummary(result: { stopped: string[]; failed: { id: string; reason: string }[] }) {
  const reasons = [...new Set(result.failed.map((item) => item.reason))].join("; ")
  const failed = result.failed.length ? ` · ${result.failed.length} couldn't be stopped (${reasons})` : ""
  return `Stopped ${result.stopped.length}${failed}`
}
