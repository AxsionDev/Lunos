import type { SessionOverviewItem } from "@opencode-ai/sdk/v2/client"
import { projectName, toolName, toolOnly } from "./sessions-model"

/**
 * XCOD-262: the Agent Monitor layout of the Sessions window (web /sessions, desktop Sessions
 * window). Pure, so the rail's sections, its numbers, `@` tags and how a prompt reaches a session
 * are tested without a DOM. The same rules as the TUI's monitor (packages/tui/src/util/agent-monitor.ts).
 */

/**
 * XCOD-299: the TUI's three sub-sections (packages/tui/src/util/subagent-groups.ts): Working
 * ("running", for its i18n key), Waiting for action, Completed. Always in this order, empty ones too.
 */
export type MonitorSection = "running" | "waiting" | "completed"

export const MONITOR_SECTIONS: MonitorSection[] = ["running", "waiting", "completed"]

/** Completed sessions older than this are behind "Show older". */
export const RECENT_MS = 24 * 60 * 60 * 1000

/** Rail numbers, for `@n` tags. */
export const MAX_NUMBER = 99

export type RailRow = {
  item: SessionOverviewItem
  section: MonitorSection
  /** 1 for a subagent shown under its parent. */
  depth: 0 | 1
}

export type Rail = {
  /** Every row, collapsed sections' too, in rail order (numbers and tags use it). */
  rows: RailRow[]
  counts: Record<MonitorSection, number>
  /** Completed sessions hidden behind "Show older". */
  older: number
}

type Effective = "waiting" | "running" | "failed" | "done"

function effectiveOf(item: SessionOverviewItem): Effective {
  if (item.state === "waiting") return "waiting"
  if (item.state === "running") return "running"
  if (item.state === "failed") return "failed"
  return "done"
}

const SECTION_OF: Record<Effective, MonitorSection> = {
  waiting: "waiting",
  running: "running",
  failed: "completed",
  done: "completed",
}

const URGENCY: Record<Effective, number> = { waiting: 0, running: 1, failed: 2, done: 3 }

function matches(item: SessionOverviewItem, search: string) {
  if (!search) return true
  return [item.title, projectName(item), item.directory, item.state, item.agent, item.model, toolName(item)]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(search))
}

/**
 * Working, Waiting for action, Completed (failed ones first), newest first inside each. A subagent
 * sits under its parent, and a parent moves to its most urgent child's section, so a background
 * subagent asking for approval surfaces under Waiting for action with its parent. Archived sessions
 * (cleared from the list) aren't in the rail.
 */
export function rail(input: {
  sessions: readonly SessionOverviewItem[]
  now: number
  search?: string
  showOlder?: boolean
}): Rail {
  const search = (input.search ?? "").trim().toLowerCase()
  const sessions = input.sessions.filter((item) => !item.archived)
  const ids = new Set(sessions.map((item) => item.id))
  const children = new Map<string, SessionOverviewItem[]>()
  for (const item of sessions) {
    if (!item.parentID || !ids.has(item.parentID)) continue
    children.set(item.parentID, [...(children.get(item.parentID) ?? []), item])
  }
  const newest = (a: SessionOverviewItem, b: SessionOverviewItem) => b.updated - a.updated

  const groups: Record<MonitorSection, { item: SessionOverviewItem; kids: SessionOverviewItem[]; state: Effective }[]> =
    { running: [], waiting: [], completed: [] }
  let older = 0
  for (const item of sessions) {
    if (item.parentID && ids.has(item.parentID)) continue
    const all = (children.get(item.id) ?? []).toSorted(newest)
    const own = matches(item, search)
    const kids = own ? all : all.filter((kid) => matches(kid, search))
    if (!own && kids.length === 0) continue
    const state = [item, ...all].map(effectiveOf).reduce((best, next) => (URGENCY[next] < URGENCY[best] ? next : best))
    // A search reaches older ones too: it never hides a hit.
    if (state === "done" && !search && !input.showOlder && input.now - item.updated > RECENT_MS) {
      older++
      continue
    }
    groups[SECTION_OF[state]].push({ item, kids, state })
  }

  const rows: RailRow[] = []
  const counts = { running: 0, waiting: 0, completed: 0 }
  for (const section of MONITOR_SECTIONS) {
    // Failed before done in Completed; newest first otherwise.
    const sorted = groups[section].toSorted((a, b) => URGENCY[a.state] - URGENCY[b.state] || newest(a.item, b.item))
    for (const entry of sorted) {
      rows.push({ item: entry.item, section, depth: 0 })
      for (const kid of entry.kids) rows.push({ item: kid, section, depth: 1 })
    }
    counts[section] = rows.filter((row) => row.section === section).length
  }
  return { rows, counts, older }
}

/**
 * What the user opened or collapsed: true open, false collapsed, absent the default. A collapse of
 * Waiting for action remembers the asks it hid (`waitingSeen`), so a new one opens it again.
 */
export type SectionOverrides = Partial<Record<MonitorSection, boolean>> & { waitingSeen?: string[] }

export type SectionView = {
  section: MonitorSection
  count: number
  open: boolean
  /** Shown "(0)", dimmed and collapsed. */
  empty: boolean
  /** For the collapsed header: how many are in each state. */
  states: { state: "running" | "waiting" | "failed" | "finished"; count: number }[]
}

/** Each section's header: open or not, empty, and what it holds; `reopened` when a new ask opened Waiting again. */
export function sections(value: Rail, overrides: SectionOverrides = {}) {
  const waiting = value.rows.filter((row) => row.section === "waiting").map((row) => row.item.id)
  const seen = new Set(overrides.waitingSeen ?? [])
  const reopened = overrides.waiting === false && waiting.some((id) => !seen.has(id))
  const views = MONITOR_SECTIONS.map((section): SectionView => {
    const rows = value.rows.filter((row) => row.section === section)
    const count = rows.length
    const chosen = section === "waiting" && reopened ? undefined : overrides[section]
    const states = (
      section === "running"
        ? (["running"] as const)
        : section === "waiting"
          ? (["waiting"] as const)
          : (["failed", "finished"] as const)
    )
      .map((state) => ({
        state,
        count: rows.filter((row) =>
          state === "finished" ? row.item.state !== "failed" : state === "failed" ? row.item.state === "failed" : true,
        ).length,
      }))
      .filter((entry) => entry.count > 0)
    // Open unless the user collapsed it: unlike the TUI sidebar, Completed doesn't start collapsed here.
    return { section, count, open: count > 0 && (chosen ?? true), empty: count === 0, states }
  })
  return { views, reopened }
}

/** The overrides after a click on a section's header. Cleared keys are undefined, so a merged store drops them. */
export function toggleSection(overrides: SectionOverrides, view: SectionView, waitingIDs: readonly string[]) {
  if (view.empty) return overrides
  const next: SectionOverrides = { ...overrides, [view.section]: !view.open }
  if (view.section === "waiting") next.waitingSeen = view.open ? [...waitingIDs] : undefined
  return next
}

/** The overrides once a new ask reopened Waiting for action: its collapse is forgotten. */
export function forgetWaiting(overrides: SectionOverrides): SectionOverrides {
  return { ...overrides, waiting: undefined, waitingSeen: undefined }
}

/**
 * Rail numbers. They're handed out in rail order, and a session keeps its number while the window
 * is open: a row that turns Waiting moves to the top without renumbering the others, so an `@2`
 * typed a moment ago still means the same session. A number isn't reused while the window is open
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
 * so the window can say so instead of starting a new session with "@7 do X".
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

/** The text with one session's `@n` tags taken out (a chip's remove button). */
export function untag(text: string, value: number) {
  return text
    .replace(TAG, (match, lead: string, digits: string) => (Number(digits) === value ? lead : match))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^ /, "")
}

/** The `@word` being typed at the caret, for the sessions autocomplete; undefined when there's none. */
export function mentionAt(text: string, caret: number) {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  if (!match) return undefined
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

/**
 * The sessions an `@query` offers, rail order: its number first ("@2"), then title or project words.
 * Claude Code / Codex rows with no Lunos session aren't offered: they take no prompts from here.
 */
export function mentionOptions(rows: readonly RailRow[], numbers: ReadonlyMap<string, number>, query: string) {
  const search = query.toLowerCase()
  const offered = rows.filter((row) => numbers.has(row.item.id) && !toolOnly(row.item))
  const byNumber = offered.filter((row) => /^\d+$/.test(search) && String(numbers.get(row.item.id)).startsWith(search))
  const byName = offered.filter(
    (row) =>
      !byNumber.includes(row) &&
      [row.item.title, projectName(row.item)].some((value) => value.toLowerCase().includes(search)),
  )
  return [...byNumber, ...byName].map((row) => ({ item: row.item, number: numbers.get(row.item.id)! }))
}

/** Puts `@n ` where the `@query` being typed is. */
export function insertMention(text: string, mention: { start: number; query: string }, value: number) {
  const end = mention.start + 1 + mention.query.length
  const after = text.slice(end)
  const inserted = `@${value}${after.startsWith(" ") ? "" : " "}`
  return { text: text.slice(0, mention.start) + inserted + after, caret: mention.start + inserted.length }
}

export type Route =
  /** A Claude Code / Codex session with no Lunos session: only its tool takes prompts. */
  | { type: "tool-only" }
  /**
   * Its Lunos stopped mid-turn, or with prompts queued for it: ask "Take over this session here?"
   * before running it here (and what to do with the queued ones).
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

/** XCOD-262: prompts a Lunos that stopped queued for the session, sent or discarded only on take-over. */
export function orphanedQueue(item: Pick<SessionOverviewItem, "queued" | "ownerClosed">) {
  return item.ownerClosed ? (item.queued ?? 0) : 0
}

/** XCOD-268: a row whose closed Lunos left prompts queued, which Take over sends or discards with no new prompt. */
export function canTakeOver(item: Pick<SessionOverviewItem, "id" | "queued" | "ownerClosed" | "elsewhere">) {
  return orphanedQueue(item) > 0 && !item.elsewhere && !toolOnly(item)
}

export type Asks = {
  permissions: ReadonlyArray<{ id: string; permission: string; patterns: ReadonlyArray<string> }>
  questions: ReadonlyArray<{ id: string; questions: ReadonlyArray<{ question: string }> }>
}

/** What a Waiting row asks: the first approval ("bash git push origin main"), else the first question. */
export function ask(asks: Asks | undefined) {
  const permission = asks?.permissions[0]
  if (permission)
    return {
      type: "permission" as const,
      id: permission.id,
      text: `${permission.permission}${permission.patterns.length ? ` ${permission.patterns.join(", ")}` : ""}`,
    }
  const question = asks?.questions[0]
  const text = question?.questions[0]?.question
  if (question && text) return { type: "question" as const, id: question.id, text }
  return undefined
}
