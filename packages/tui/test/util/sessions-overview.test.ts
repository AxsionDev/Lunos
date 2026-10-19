import { describe, expect, test } from "bun:test"
import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2"
import {
  STATE_GLYPH,
  STATE_FILTERS,
  UNGROUPED_KEY,
  ago,
  build,
  clearPlan,
  clearQuestion,
  groupKey,
  inView,
  kindLabel,
  money,
  nextStateFilter,
  projectName,
  stateLabel,
  stopAndClearQuestion,
  stopPlan,
  stopQuestion,
  stopSummary,
  stoppable,
  toolOnly,
  waiting,
  type Line,
} from "../../src/util/sessions-overview"

function item(id: string, extra: Partial<SessionOverviewItem> = {}): SessionOverviewItem {
  return {
    id,
    kind: "session",
    title: id,
    directory: "/work/alpha",
    project: { id: "prj_a", name: "alpha", worktree: "/work/alpha" },
    cost: 0,
    created: 1,
    updated: 1,
    state: "idle",
    permissions: 0,
    questions: 0,
    ...extra,
  }
}

const group = (id: string, name: string, collapsed = false): SessionGroup => ({
  id,
  name,
  collapsed,
  created: 1,
  updated: 1,
})

const view = (lines: Line[]) =>
  lines.map((line) =>
    line.type === "group"
      ? `[${line.group?.name ?? "Ungrouped"} ${line.count}${line.collapsed ? " collapsed" : ""}]`
      : `${line.depth ? "  " : ""}${line.item.id}`,
  )

describe("TUI /sessions model (XCOD-205)", () => {
  test("groups in their order, then Ungrouped; newest first; a deleted group's sessions are Ungrouped", () => {
    const lines = build({
      groups: [group("g1", "Client A"), group("g2", "Client B")],
      sessions: [
        item("a", { groupID: "g2", updated: 5 }),
        item("b", { updated: 9 }),
        item("c", { groupID: "g2", updated: 7 }),
        item("d", { groupID: "gone", updated: 3 }),
      ],
      search: "",
      state: "all",
    })
    expect(view(lines)).toEqual(["[Client A 0]", "[Client B 2]", "c", "a", "[Ungrouped 2]", "b", "d"])
    expect(lines[0]!.key).toBe(groupKey("g1"))
    expect(lines[4]!.key).toBe(UNGROUPED_KEY)
  })

  test("an empty Ungrouped is left out, an empty group is kept so sessions can be moved into it", () => {
    const lines = build({ groups: [group("g1", "Empty")], sessions: [], search: "", state: "all" })
    expect(view(lines)).toEqual(["[Empty 0]"])
  })

  test("subagents sit under their parent, whatever their own group; orphans stand alone", () => {
    const lines = build({
      groups: [group("g1", "Work")],
      sessions: [
        item("parent", { groupID: "g1", updated: 2 }),
        item("kid", { kind: "subagent", parentID: "parent", updated: 3 }),
        item("orphan", { kind: "subagent", parentID: "missing", updated: 1 }),
      ],
      search: "",
      state: "all",
    })
    expect(view(lines)).toEqual(["[Work 1]", "parent", "  kid", "[Ungrouped 1]", "orphan"])
  })

  test("a collapsed group shows only its header; Ungrouped collapses locally", () => {
    const lines = build({
      groups: [group("g1", "Work", true)],
      sessions: [item("a", { groupID: "g1" }), item("b")],
      search: "",
      state: "all",
      ungroupedCollapsed: true,
    })
    expect(view(lines)).toEqual(["[Work 1 collapsed]", "[Ungrouped 1 collapsed]"])
  })

  test("search matches name, project, state and group, and shows hits inside collapsed groups", () => {
    const groups = [group("g1", "Acme", true)]
    const sessions = [
      item("fix login", { groupID: "g1" }),
      item("write docs", { project: { id: "p", name: "handbook", worktree: "/w/handbook" } }),
      item("deploy", { state: "waiting" }),
    ]
    const ids = (search: string) =>
      build({ groups, sessions, search, state: "all" }).flatMap((line) =>
        line.type === "session" ? [line.item.id] : [],
      )
    expect(ids("LOGIN")).toEqual(["fix login"])
    expect(ids("handbook")).toEqual(["write docs"])
    expect(ids("waiting for approval")).toEqual(["deploy"])
    expect(ids("acme")).toEqual(["fix login"])
    // Sections without a hit are hidden while searching.
    expect(view(build({ groups, sessions, search: "handbook", state: "all" }))).toEqual(["[Ungrouped 1]", "write docs"])
  })

  test("a subagent hit keeps its parent visible, showing only the matching children", () => {
    const lines = build({
      groups: [],
      sessions: [
        item("parent"),
        item("kid-one", { kind: "subagent", parentID: "parent", title: "research" }),
        item("kid-two", { kind: "subagent", parentID: "parent", title: "review" }),
      ],
      search: "research",
      state: "all",
    })
    expect(view(lines)).toEqual(["[Ungrouped 1]", "parent", "  kid-one"])
  })

  test("the state filter keeps only that state and cycles all → waiting → … → all", () => {
    const lines = build({
      groups: [],
      sessions: [item("a", { state: "running" }), item("b", { state: "failed" })],
      search: "",
      state: "failed",
    })
    expect(view(lines)).toEqual(["[Ungrouped 1]", "b"])
    let state = STATE_FILTERS[0]!
    const seen = [state]
    for (let i = 0; i < STATE_FILTERS.length; i++) seen.push((state = nextStateFilter(state)))
    expect(seen).toEqual([...STATE_FILTERS, "all"])
  })

  // XCOD-141: a state must never rely on colour alone.
  test("every state has its own glyph and a text label", () => {
    const glyphs = Object.values(STATE_GLYPH)
    expect(new Set(glyphs).size).toBe(glyphs.length)
    expect(stateLabel({ state: "waiting" })).toBe("waiting for approval")
    expect(stateLabel({ state: "running", elsewhere: true })).toBe("running in another Lunos")
  })

  test("labels, project names, times, money, stop and waiting count", () => {
    expect(kindLabel({ kind: "session" })).toBeUndefined()
    expect(kindLabel({ kind: "subagent" })).toBe("subagent")
    expect(kindLabel({ kind: "scheduled" })).toBe("scheduled")
    expect(kindLabel({ kind: "external", tool: "claude" })).toBe("Claude Code")
    expect(kindLabel({ kind: "external", tool: "codex" })).toBe("Codex")
    expect(kindLabel({ kind: "external", tool: "aider" })).toBe("external (aider)")
    expect(projectName({ directory: "/a/b/repo" })).toBe("repo")
    expect(projectName({ directory: "/x", project: { id: "p", worktree: "/w/named" } })).toBe("named")
    expect(projectName({ directory: "/w/beta", project: { id: "global", worktree: "/w/alpha" } })).toBe("beta")
    expect(ago(10_000, 20_000)).toBe("now")
    expect(ago(0, 5 * 60_000)).toBe("5m ago")
    expect(ago(0, 3 * 3_600_000)).toBe("3h ago")
    expect(ago(0, 2 * 86_400_000)).toBe("2d ago")
    expect(money(0)).toBe("$0.00")
    expect(money(0.004)).toBe("<$0.01")
    expect(money(1.234)).toBe("$1.23")
    expect(stoppable({ id: "ses_1", state: "running" })).toBe(true)
    expect(stoppable({ id: "ses_1", state: "waiting" })).toBe(true)
    expect(stoppable({ id: "ses_1", state: "idle" })).toBe(false)
    expect(stoppable({ id: "ses_1", state: "running", elsewhere: true })).toBe(true)
    expect(stoppable({ id: "ses_1", state: "idle", stale: true })).toBe(false)
    // A tool-only external row runs in its own process; an /external session is a Lunos session.
    expect(toolOnly({ id: "external:abc" })).toBe(true)
    // XCOD-234: a running one stops like `lunos external stop`; a finished one can't.
    expect(stoppable({ id: "external:abc", state: "running" })).toBe(true)
    expect(stoppable({ id: "external:abc", state: "finished" })).toBe(false)
    expect(toolOnly({ id: "ses_2" })).toBe(false)
    expect(waiting([{ state: "waiting" }, { state: "idle" }, { state: "waiting" }])).toBe(2)
    // XCOD-234: another process's live state, and a turn whose Lunos stopped.
    expect(stateLabel({ state: "waiting", elsewhere: true })).toBe("waiting in another Lunos")
    expect(stateLabel({ state: "running", elsewhere: true })).toBe("running in another Lunos")
    expect(stateLabel({ state: "idle", stale: true })).toBe("not responding (its Lunos closed)")
  })
})

describe("Stop all and Clear list (XCOD-265)", () => {
  // The acceptance fixture: 3 running, 2 waiting, 1 Claude Code, 1 in another Lunos and 4 finished.
  const fixture = [
    item("r1", { state: "running" }),
    item("r2", { state: "running" }),
    item("r3", { state: "running", project: { id: "prj_b", name: "beta", worktree: "/work/beta" } }),
    item("w1", { state: "waiting", permissions: 1 }),
    item("w2", { state: "waiting", questions: 1 }),
    item("external:cc", { kind: "external", tool: "claude", state: "running" }),
    item("e1", { state: "running", elsewhere: true }),
    item("f1", { state: "finished" }),
    item("f2", { state: "finished" }),
    item("f3", { state: "idle" }),
    item("f4", { state: "failed" }),
  ]
  const all = (state: Parameters<typeof inView>[0]["state"] = "all", search = "") =>
    inView({ groups: [], sessions: fixture, search, state })

  test("Stop all asks once with the right counts", () => {
    const plan = stopPlan(all())
    expect(plan.targets.map((row) => row.id)).toEqual(["r1", "r2", "r3", "w1", "w2", "external:cc", "e1"])
    expect(stopQuestion(plan)).toBe(
      "Stop 7 sessions? 4 running, 2 waiting for an answer, 1 Claude Code. 1 of them runs in another Lunos window.",
    )
    expect(plan.projects).toEqual(["alpha", "beta"])
  })

  test("with the filter on waiting, only the waiting sessions are stopped", () => {
    const plan = stopPlan(all("waiting"))
    expect(plan.targets.map((row) => row.id)).toEqual(["w1", "w2"])
    expect(stopQuestion(plan)).toBe("Stop 2 sessions? 2 waiting for an answer.")
  })

  test("the search narrows the view, and matches group names; collapsed groups still count", () => {
    const sessions = [
      item("a", { state: "running", groupID: "g1" }),
      item("b", { state: "running" }),
      item("kid", { state: "running", parentID: "a" }),
    ]
    const groups = [group("g1", "Client A", true)]
    expect(inView({ groups, sessions, search: "client a", state: "all" }).map((row) => row.id)).toEqual(["a", "kid"])
    expect(inView({ groups, sessions, search: "", state: "all" }).map((row) => row.id)).toEqual(["a", "b", "kid"])
  })

  test("Clear archives only finished, idle and failed rows; the confirmation says what stays", () => {
    const plan = clearPlan(all())
    expect(plan.targets.map((row) => row.id)).toEqual(["f1", "f2", "f3", "f4"])
    expect(plan.staying).toHaveLength(7)
    expect(clearQuestion(plan)).toBe(
      "Clear 4 sessions from the list? They're archived, not deleted: Show archived brings them back. 7 running sessions stay; stop them first, or use Stop all & clear.",
    )
    expect(clearQuestion(clearPlan(all("finished")))).toBe(
      "Clear 2 sessions from the list? They're archived, not deleted: Show archived brings them back.",
    )
  })

  test("Stop all & clear lists both steps in one confirmation", () => {
    expect(stopAndClearQuestion(all())).toBe(
      "Stop 7 sessions and clear 11 from the list? 1. Stop 4 running, 2 waiting for an answer, 1 Claude Code (1 in another Lunos window). 2. Archive all 11: they're hidden, not deleted, and Show archived brings them back.",
    )
  })

  test("the result toast counts what stopped and why the rest didn't", () => {
    expect(stopSummary({ stopped: ["a", "b"], failed: [] })).toBe("Stopped 2")
    expect(
      stopSummary({
        stopped: ["a", "b", "c", "d", "e", "f", "g"],
        failed: [{ id: "x", reason: "another Lunos didn't respond" }],
      }),
    ).toBe("Stopped 7 · 1 couldn't be stopped (another Lunos didn't respond)")
  })

  test("the archived view lists archived rows whatever their state, without group headings for filtering", () => {
    const sessions = [item("old", { state: "finished", archived: 5 }), item("older", { state: "failed", archived: 4 })]
    expect(inView({ groups: [], sessions, search: "", state: "archived" })).toHaveLength(2)
    expect(view(build({ groups: [], sessions, search: "", state: "archived" }))).toEqual([
      "[Ungrouped 2]",
      "old",
      "older",
    ])
  })
})
