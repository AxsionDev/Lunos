import type { SessionOverviewItem } from "@opencode-ai/sdk/v2/client"
import { projectName, toolName, toolOnly } from "./sessions-model"

/**
 * XCOD-262: the Agent Monitor layout of the Sessions window (web /sessions, desktop Sessions
 * window). Pure, so the rail's sections, its numbers, `@` tags and how a prompt reaches a session
 * are tested without a DOM. The same rules as the TUI's monitor (packages/tui/src/util/agent-monitor.ts).
 */

export type MonitorSection = "waiting" | "running" | "completed" | "failed"

export const MONITOR_SECTIONS: MonitorSection[] = ["waiting", "running", "completed", "failed"]

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
  rows: RailRow[]
  counts: Record<MonitorSection, number>
  /** Completed sessions hidden behind "Show older". */
  older: number
}

function sectionOf(item: SessionOverviewItem): MonitorSection {
  if (item.state === "waiting") return "waiting"
  if (item.state === "running") return "running"
  if (item.state === "failed") return "failed"
  return "completed"
}

const URGENCY: Record<MonitorSection, number> = { waiting: 0, running: 1, failed: 2, completed: 3 }

function matches(item: SessionOverviewItem, search: string) {
  if (!search) return true
  return [item.title, projectName(item), item.directory, item.state, item.agent, item.model, toolName(item)]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(search))
}

/**
 * Sections in the ticket's order (Waiting, Running, Completed, Failed), newest first inside each.
 * A subagent sits under its parent, and a parent moves to its most urgent child's section, so a
 * background subagent asking for approval surfaces under Waiting with its parent. Archived sessions
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

  const groups: Record<MonitorSection, { item: SessionOverviewItem; kids: SessionOverviewItem[] }[]> = {
    waiting: [],
    running: [],
    completed: [],
    failed: [],
  }
  let older = 0
  for (const item of sessions) {
    if (item.parentID && ids.has(item.parentID)) continue
    const all = (children.get(item.id) ?? []).toSorted(newest)
    const own = matches(item, search)
    const kids = own ? all : all.filter((kid) => matches(kid, search))
    if (!own && kids.length === 0) continue
    const section = [item, ...all].map(sectionOf).reduce((best, next) => (URGENCY[next] < URGENCY[best] ? next : best))
    // A search reaches older ones too: it never hides a hit.
    if (section === "completed" && !search && !input.showOlder && input.now - item.updated > RECENT_MS) {
      older++
      continue
    }
    groups[section].push({ item, kids })
  }

  const rows: RailRow[] = []
  const counts = { waiting: 0, running: 0, completed: 0, failed: 0 }
  for (const section of MONITOR_SECTIONS) {
    for (const entry of groups[section].toSorted((a, b) => newest(a.item, b.item))) {
      rows.push({ item: entry.item, section, depth: 0 })
      counts[section]++
      for (const kid of entry.kids) rows.push({ item: kid, section, depth: 1 })
    }
  }
  return { rows, counts, older }
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
  /** Its Lunos stopped mid-turn: ask "Take over this session here?" before running it here. */
  | { type: "takeover" }
  /** Another live Lunos process runs it: `peer.prompt`, run by that process. */
  | { type: "peer" }
  /** This Lunos runs it, or nobody does. */
  | { type: "local" }

/** Where a tagged prompt goes. One session is never driven by two processes. */
export function route(item: Pick<SessionOverviewItem, "id" | "elsewhere" | "stale">): Route {
  if (toolOnly(item)) return { type: "tool-only" }
  if (item.elsewhere) return { type: "peer" }
  if (item.stale) return { type: "takeover" }
  return { type: "local" }
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
