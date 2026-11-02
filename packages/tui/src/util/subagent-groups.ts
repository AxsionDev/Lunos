import type { SubagentState } from "./subagent-avatar"

/**
 * XCOD-299: the three sub-sections the sidebar's Subagents section and the Agent Monitor's rail are
 * split into. Pure, so which sub-section a subagent sits in, the order inside it, the counts, what
 * is open and the collapsed summary are tested without a terminal. The desktop and web monitor
 * mirror it (packages/app/src/pages/sessions/monitor-model.ts).
 */

export type Group = "working" | "waiting" | "completed"

/** Always in this order, empty ones too, so the three never move. */
export const GROUPS: readonly Group[] = ["working", "waiting", "completed"]

export const GROUP_TITLE: Record<Group, string> = {
  working: "Working",
  waiting: "Waiting for action",
  completed: "Completed",
}

/** In the sidebar, Completed starts collapsed when it holds more than this many. */
export const COMPLETED_OPEN_MAX = 3

/** Not colour alone (XCOD-141): each state has its own glyph. */
export const GROUP_GLYPH: Record<SubagentState, string> = {
  running: "◐",
  queued: "◌",
  waiting: "!",
  failed: "✕",
  done: "✓",
}

/** A row's own state, as text, inside its sub-section ("running" under Working, not "Working"). */
export const ROW_LABEL: Record<SubagentState, string> = {
  running: "running",
  queued: "queued",
  waiting: "waiting",
  failed: "failed",
  done: "done",
}

export function groupOf(state: SubagentState): Group {
  if (state === "running" || state === "queued") return "working"
  if (state === "waiting") return "waiting"
  return "completed"
}

export type GroupItem = {
  id: string
  state: SubagentState
  /** The subagent (or session) that launched it, when that is listed too. */
  parent?: string
  /** When it started (ms): the longest-running is at the top of Working. */
  started?: number
}

/**
 * What the user chose, per sub-section: true open, false collapsed, absent the default. A collapse
 * of Waiting remembers the asks it hid (`waitingSeen`), so a new one opens it again.
 */
export type Overrides = Partial<Record<Group, boolean>> & { waitingSeen?: string[] }

export type GroupRow<T> = { item: T; group: Group; depth: number }

export type GroupView<T> = {
  group: Group
  title: string
  count: number
  open: boolean
  /** Shown "(0)", dimmed and collapsed. */
  empty: boolean
  rows: GroupRow<T>[]
  /** For the collapsed header: "✕ 1 failed · ✓ 1 done". */
  summary: string
  /** For screen readers and NO_COLOR: "Waiting for action, 2". */
  label: string
}

export type Grouped<T> = {
  groups: GroupView<T>[]
  total: number
  /** How many need you. */
  waiting: number
  /** "7 · 2 need you", or "7". */
  header: string
  /** Waiting was collapsed and a new ask arrived: it is open again, and the collapse should be forgotten. */
  reopened: boolean
}

/** Order of the states inside a sub-section: running before queued, failed before done. */
const RANK: Record<SubagentState, number> = { running: 0, queued: 1, waiting: 0, failed: 0, done: 1 }

function summaryOf(rows: readonly { state: SubagentState }[], states: readonly SubagentState[]) {
  return states
    .map((state) => ({ state, count: rows.filter((row) => row.state === state).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${GROUP_GLYPH[entry.state]} ${entry.count} ${ROW_LABEL[entry.state]}`)
    .join(" · ")
}

const SUMMARY_STATES: Record<Group, readonly SubagentState[]> = {
  working: ["running", "queued"],
  waiting: ["waiting"],
  completed: ["failed", "done"],
}

/**
 * Splits subagents into Working, Waiting for action and Completed.
 *
 * - Working: running ones first, the longest-running at the top, then queued ones.
 * - Waiting for action: in launch order.
 * - Completed: failed ones first, then done ones.
 *
 * Ties keep the order the items came in (launch order). `nest` says where a listed parent's
 * children go: "own" puts each in the sub-section of its own state, indented under its parent when
 * that sits in the same one (the sidebar); "parent" keeps them under their parent wherever it is
 * (the Agent Monitor, whose parent already carries its most urgent child's state).
 */
export function groupSubagents<T extends GroupItem>(
  items: readonly T[],
  options: {
    overrides?: Overrides
    nest?: "own" | "parent"
    /** Completed starts collapsed above this many (the Agent Monitor keeps it open: Infinity). */
    completedOpenMax?: number
  } = {},
): Grouped<T> {
  const overrides = options.overrides ?? {}
  const nest = options.nest ?? "own"
  const index = new Map(items.map((item, at) => [item.id, at]))
  const byID = new Map(items.map((item) => [item.id, item]))

  // The sub-section each item is placed in.
  const placed = new Map<string, Group>()
  const place = (item: T, seen = new Set<string>()): Group => {
    const known = placed.get(item.id)
    if (known) return known
    const parent = item.parent ? byID.get(item.parent) : undefined
    const group =
      nest === "parent" && parent && !seen.has(parent.id)
        ? place(parent, new Set([...seen, item.id]))
        : groupOf(item.state)
    placed.set(item.id, group)
    return group
  }
  for (const item of items) place(item)

  const compare = (a: T, b: T) => {
    const rank = RANK[a.state] - RANK[b.state]
    if (rank) return rank
    if (a.state === "running" && b.state === "running") {
      const started = (a.started ?? Infinity) - (b.started ?? Infinity)
      if (started) return started
    }
    return index.get(a.id)! - index.get(b.id)!
  }

  const children = new Map<string, T[]>()
  for (const item of items) {
    const parent = item.parent ? byID.get(item.parent) : undefined
    if (!parent || parent.id === item.id || placed.get(parent.id) !== placed.get(item.id)) continue
    children.set(parent.id, [...(children.get(parent.id) ?? []), item])
  }
  const isChild = (item: T) => {
    const parent = item.parent ? byID.get(item.parent) : undefined
    return !!parent && parent.id !== item.id && placed.get(parent.id) === placed.get(item.id)
  }

  const waitingIDs = items.filter((item) => placed.get(item.id) === "waiting").map((item) => item.id)
  const seen = new Set(overrides.waitingSeen ?? [])
  const reopened = overrides.waiting === false && waitingIDs.some((id) => !seen.has(id))

  const groups = GROUPS.map((group): GroupView<T> => {
    const rows: GroupRow<T>[] = []
    const visited = new Set<string>()
    const walk = (item: T, depth: number) => {
      if (visited.has(item.id)) return
      visited.add(item.id)
      rows.push({ item, group, depth })
      for (const child of (children.get(item.id) ?? []).toSorted(compare)) walk(child, depth + 1)
    }
    const members = items.filter((item) => placed.get(item.id) === group)
    for (const item of members.filter((item) => !isChild(item)).toSorted(compare)) walk(item, 0)
    // A parent loop (never expected) still lists everyone.
    for (const item of members.toSorted(compare)) walk(item, 0)

    const count = rows.length
    const empty = count === 0
    const fallback = group === "completed" ? count <= (options.completedOpenMax ?? COMPLETED_OPEN_MAX) : true
    const chosen = group === "waiting" && reopened ? undefined : overrides[group]
    const open = !empty && (chosen ?? fallback)
    return {
      group,
      title: GROUP_TITLE[group],
      count,
      open,
      empty,
      rows,
      summary: summaryOf(
        rows.map((row) => row.item),
        SUMMARY_STATES[group],
      ),
      label: `${GROUP_TITLE[group]}, ${count}`,
    }
  })

  const waiting = waitingIDs.length
  return {
    groups,
    total: items.length,
    waiting,
    header: waiting > 0 ? `${items.length} · ${waiting} need you` : `${items.length}`,
    reopened,
  }
}

// Both return every key they clear as undefined, not left out: kv merges an object into the one it
// keeps, so a key that is only missing would stay.

/** The overrides after a click or Enter on a sub-section's header. */
export function toggle(overrides: Overrides, view: Pick<GroupView<GroupItem>, "group" | "open" | "empty" | "rows">) {
  if (view.empty) return overrides
  const next: Overrides = { ...overrides, [view.group]: !view.open }
  if (view.group === "waiting") next.waitingSeen = view.open ? view.rows.map((row) => row.item.id) : undefined
  return next
}

/** The overrides once a new ask reopened Waiting: its collapse is forgotten. */
export function forgetWaiting(overrides: Overrides): Overrides {
  return { ...overrides, waiting: undefined, waitingSeen: undefined }
}
