import type { SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { kindLabel, projectName, stateLabel, toolOnly } from "./sessions-overview"

/**
 * XCOD-262: the model behind the Agent Monitor (← on an empty prompt, /monitor). Pure, so the rail's
 * sections, its numbers, `@` tags and how a prompt reaches a session are tested without a terminal.
 * The rows come from the same `session.overview` as /sessions.
 */

export type Section = "waiting" | "running" | "completed" | "failed"

export const SECTIONS: Section[] = ["waiting", "running", "completed", "failed"]

export const SECTION_TITLE: Record<Section, string> = {
  waiting: "Waiting for you",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
}

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
  rows: Row[]
  counts: Record<Section, number>
  /** Completed sessions hidden behind "Show older". */
  older: number
}

/**
 * The sessions the rail lists: none that were cleared from the list (archived, XCOD-265). The
 * overview already leaves them out unless asked for them; this keeps the rail right either way.
 */
export function railItems(sessions: readonly SessionOverviewItem[]) {
  return sessions.filter((item) => !item.archived)
}

function sectionOf(item: SessionOverviewItem): Section {
  if (item.state === "waiting") return "waiting"
  if (item.state === "running") return "running"
  if (item.state === "failed") return "failed"
  return "completed"
}

const URGENCY: Record<Section, number> = { waiting: 0, running: 1, failed: 2, completed: 3 }

function matches(item: SessionOverviewItem, search: string) {
  if (!search) return true
  return [item.title, projectName(item), item.directory, stateLabel(item), kindLabel(item), item.agent, item.tool]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(search))
}

/**
 * Sections in the ticket's order (Waiting, Running, Completed, Failed), newest first inside each.
 * A subagent sits under its parent, and a parent moves to its most urgent child's section, so a
 * background subagent asking for approval surfaces under Waiting with its parent.
 */
export function build(input: {
  sessions: readonly SessionOverviewItem[]
  now: number
  search?: string
  showOlder?: boolean
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

  const groups: Record<Section, { item: SessionOverviewItem; kids: SessionOverviewItem[] }[]> = {
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

  const rows: Row[] = []
  const counts = { waiting: 0, running: 0, completed: 0, failed: 0 }
  for (const section of SECTIONS) {
    for (const entry of groups[section].toSorted((a, b) => newest(a.item, b.item))) {
      rows.push({ item: entry.item, section, depth: 0 })
      counts[section]++
      for (const kid of entry.kids) rows.push({ item: kid, section, depth: 1 })
    }
  }
  return { rows, counts, older }
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
