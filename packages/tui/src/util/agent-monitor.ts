import type { SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { kindLabel, projectName, stateLabel, toolOnly } from "./sessions-overview"
import type { SubagentState } from "./subagent-avatar"
import {
  GROUP_TITLE,
  GROUPS,
  groupSubagents,
  type Group,
  type GroupItem,
  type GroupView,
  type Overrides,
} from "./subagent-groups"

/**
 * XCOD-262: the model behind the Agent Monitor (← on an empty prompt, /monitor). Pure, so the rail's
 * sections, its numbers, `@` tags and how a prompt reaches a session are tested without a terminal.
 * The rows come from the same `session.overview` as /sessions.
 */

// XCOD-299: the rail has the sidebar's three sub-sections, from the same function.
export type Section = Group

export const SECTIONS: readonly Section[] = GROUPS

export const SECTION_TITLE: Record<Section, string> = GROUP_TITLE

/** Where the rail's expand/collapse choices are kept (kv.json). */
export const MONITOR_GROUPS_KEY = "agent_monitor_groups"

/** Completed sessions older than this are behind "Show older". */
export const RECENT_MS = 24 * 60 * 60 * 1000

/** Rail numbers, for `@n` tags. */
export const MAX_NUMBER = 99

export type Row = {
  item: SessionOverviewItem
  section: Section
  /** 1 for a subagent shown under its parent. */
  depth: 0 | 1
}

export type Rail = {
  /** Every row, collapsed sub-sections too, in rail order (numbers and tags use it). */
  rows: Row[]
  counts: Record<Section, number>
  /** The three sub-sections, in order: open or not, empty, the collapsed summary. */
  groups: GroupView<RailItem>[]
  /** Waiting for action was collapsed and a new ask arrived: it is open again. */
  reopened: boolean
  /** Completed sessions hidden behind "Show older". */
  older: number
}

type RailItem = GroupItem & { item: SessionOverviewItem }

/**
 * The sessions the rail lists: none that were cleared from the list (archived, XCOD-265). The
 * overview already leaves them out unless asked for them; this keeps the rail right either way.
 */
export function railItems(sessions: readonly SessionOverviewItem[]) {
  return sessions.filter((item) => !item.archived)
}

/** A session's state, as a subagent's: finished and idle ones are done. */
const STATE: Record<SessionOverviewItem["state"], SubagentState> = {
  running: "running",
  waiting: "waiting",
  failed: "failed",
  finished: "done",
  idle: "done",
}

const URGENCY: Record<SessionOverviewItem["state"], number> = {
  waiting: 0,
  running: 1,
  failed: 2,
  finished: 3,
  idle: 3,
}

function matches(item: SessionOverviewItem, search: string) {
  if (!search) return true
  return [item.title, projectName(item), item.directory, stateLabel(item), kindLabel(item), item.agent, item.tool]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(search))
}

/**
 * Working, Waiting for action and Completed (failed ones first), newest first inside each. A
 * subagent sits under its parent, and a parent moves to its most urgent child's sub-section, so a
 * background subagent asking for approval surfaces under Waiting for action with its parent.
 */
export function build(input: {
  sessions: readonly SessionOverviewItem[]
  now: number
  search?: string
  showOlder?: boolean
  overrides?: Overrides
}): Rail {
  const search = (input.search ?? "").trim().toLowerCase()
  const sessions = railItems(input.sessions)
  const ids = new Set(sessions.map((item) => item.id))
  const children = new Map<string, SessionOverviewItem[]>()
  for (const item of sessions) {
    if (!item.parentID || !ids.has(item.parentID)) continue
    children.set(item.parentID, [...(children.get(item.parentID) ?? []), item])
  }
  const newest = (a: SessionOverviewItem, b: SessionOverviewItem) => b.updated - a.updated

  const items: RailItem[] = []
  let older = 0
  for (const item of sessions.toSorted(newest)) {
    if (item.parentID && ids.has(item.parentID)) continue
    const all = (children.get(item.id) ?? []).toSorted(newest)
    const own = matches(item, search)
    const kids = own ? all : all.filter((kid) => matches(kid, search))
    if (!own && kids.length === 0) continue
    const state = [item, ...all]
      .map((each) => each.state)
      .reduce((best, next) => (URGENCY[next] < URGENCY[best] ? next : best))
    // A search reaches older ones too: it never hides a hit.
    if (STATE[state] === "done" && !search && !input.showOlder && input.now - item.updated > RECENT_MS) {
      older++
      continue
    }
    items.push({ id: item.id, state: STATE[state], item })
    for (const kid of kids) items.push({ id: kid.id, state: STATE[kid.state], parent: item.id, item: kid })
  }

  // Completed stays open however many it holds: the rail is how they're reached (and numbered).
  const grouped = groupSubagents(items, { overrides: input.overrides, nest: "parent", completedOpenMax: Infinity })
  const rows = grouped.groups.flatMap((view) =>
    view.rows.map((row): Row => ({ item: row.item.item, section: view.group, depth: row.depth ? 1 : 0 })),
  )
  const counts = Object.fromEntries(grouped.groups.map((view) => [view.group, view.count])) as Record<Section, number>
  return { rows, counts, groups: grouped.groups, reopened: grouped.reopened, older }
}

/**
 * Rail numbers. They're handed out in rail order, and a session keeps its number while the monitor
 * is open: a row that turns Waiting moves to the top without renumbering the others, so an `@2`
 * typed a moment ago still means the same session. A number isn't reused while the monitor is open
 * (until all 99 are taken), for the same reason.
 */
export function number(previous: ReadonlyMap<string, number>, order: readonly string[]) {
  const next = new Map(previous)
  const used = new Set(next.values())
  let candidate = 1
  for (const id of order) {
    if (next.has(id)) continue
    while (used.has(candidate) && candidate <= MAX_NUMBER) candidate++
    if (candidate > MAX_NUMBER) break
    next.set(id, candidate)
    used.add(candidate)
  }
  return next
}

/** `@2`, as a whole word: not an email address or `@2x.png`. */
const TAG = /(^|\s)@(\d{1,2})(?=\s|$|[,.;:!?])/g

/**
 * The sessions a prompt is tagged for, and the text without its tags. Unknown numbers are returned
 * so the monitor can say so instead of starting a new session with "@7 do X".
 */
export function tags(text: string, numbers: ReadonlyMap<number, string>) {
  const targets: string[] = []
  const unknown: number[] = []
  const rest = text.replace(TAG, (_match, lead: string, digits: string) => {
    const value = Number(digits)
    const id = numbers.get(value)
    if (!id) {
      if (!unknown.includes(value)) unknown.push(value)
      return lead
    }
    if (!targets.includes(id)) targets.push(id)
    return lead
  })
  return { targets, unknown, text: rest.replace(/[ \t]{2,}/g, " ").trim() }
}

export type Route =
  /** A Claude Code / Codex session with no Lunos session: only its tool takes prompts. */
  | { type: "tool-only" }
  /**
   * Its Lunos stopped mid-turn, or with prompts queued for it: ask "Take over this session here?"
   * before running it here (and say what happens to the queued ones).
   */
  | { type: "takeover" }
  /** Another live Lunos process runs it: `peer.prompt`, run by that process. */
  | { type: "peer" }
  /** This Lunos runs it, or nobody does. */
  | { type: "local" }

/** Where a tagged prompt goes. One session is never driven by two processes. */
export function route(item: Pick<SessionOverviewItem, "id" | "elsewhere" | "stale" | "ownerClosed">): Route {
  if (toolOnly(item)) return { type: "tool-only" }
  if (item.elsewhere) return { type: "peer" }
  if (item.stale || item.ownerClosed) return { type: "takeover" }
  return { type: "local" }
}

/** "2 queued", or "2 queued (owner closed)" when the Lunos that holds them stopped. */
export function queuedLabel(item: Pick<SessionOverviewItem, "queued" | "ownerClosed">) {
  if (!item.queued) return undefined
  return item.ownerClosed ? `${item.queued} queued (owner closed)` : `${item.queued} queued`
}

/** What the take-over confirmation offers for a stopped Lunos's queued prompts: send them first, or discard them. */
export function takeoverChoices(count: number) {
  return [
    {
      value: "send" as const,
      title:
        count === 1 ? "Take over, send the queued prompt first" : `Take over, send the ${count} queued prompts first`,
    },
    { value: "discard" as const, title: count === 1 ? "Take over, discard it" : `Take over, discard all ${count}` },
  ]
}

/** The take-over question when a prompt is sent to a session whose Lunos closed with prompts queued. */
export function takeoverQuestion(title: string, count: number) {
  return `Take over this session here? The Lunos that ran "${title}" closed with ${count === 1 ? "1 prompt" : `${count} prompts`} queued for it, never sent. Sent first, they run in order before yours.`
}

/** XCOD-268: a row whose Lunos closed with prompts queued for it, which Take over can send or discard. */
export function canTakeOver(item: Pick<SessionOverviewItem, "id" | "queued" | "ownerClosed" | "elsewhere">) {
  return !!item.ownerClosed && (item.queued ?? 0) > 0 && !item.elsewhere && !toolOnly(item)
}

/** XCOD-268: Take over without a new prompt: the queued ones are all that is sent, or nothing is. */
export function takeoverOnlyChoices(count: number) {
  return [
    { value: "send" as const, title: count === 1 ? "Send 1 queued prompt" : `Send ${count} queued prompts` },
    { value: "discard" as const, title: count === 1 ? "Discard it" : "Discard them" },
  ]
}

/**
 * What ← does on a prompt. It opens the monitor only from an empty prompt (no text, no attachments)
 * in normal mode with no autocomplete open, on home or a top-level session; anything else keeps the
 * key for the cursor, the previous child session or the diff viewer.
 */
export function leftOpensMonitor(input: {
  enabled: boolean
  route: "home" | "session" | "other"
  child: boolean
  text: string
  parts: number
  mode: string
  autocomplete: boolean
}) {
  if (!input.enabled) return false
  if (input.route === "other" || (input.route === "session" && input.child)) return false
  if (input.text !== "" || input.parts > 0) return false
  return input.mode === "normal" && !input.autocomplete
}

/** "approve: bash git push origin main", or the question, for a Waiting row. */
export function askText(asks: {
  permissions: ReadonlyArray<{ permission: string; patterns: ReadonlyArray<string> }>
  questions: ReadonlyArray<{ questions: ReadonlyArray<{ question: string }> }>
}) {
  const permission = asks.permissions[0]
  if (permission)
    return `approve: ${permission.permission}${permission.patterns.length ? ` ${permission.patterns.join(", ")}` : ""}`
  const question = asks.questions[0]?.questions[0]?.question
  if (question) return `asks: ${question}`
  return undefined
}

/** Compact elapsed time: "12s", "5m", "3h", "2d". */
export function elapsed(from: number, now: number) {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}
