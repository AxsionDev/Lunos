import { describe, expect, test } from "bun:test"
import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2/client"
import {
  build,
  clearPlan,
  inView,
  money,
  projectName,
  stopPlan,
  topLevel,
  UNGROUPED,
  waiting,
  type Filter,
} from "./sessions-model"

const all: Filter = { search: "", state: "all", group: "all" }

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
  } as SessionOverviewItem
}

const group = (id: string, name: string): SessionGroup => ({ id, name, collapsed: false, created: 1, updated: 1 })

describe("Sessions window model (XCOD-205)", () => {
  test("groups first in their order, then Ungrouped; newest first inside a section", () => {
    const sections = build({
      groups: [group("g1", "Client A"), group("g2", "Client B")],
      sessions: [
        item("a", { groupID: "g2", updated: 5 }),
        item("b", { updated: 9 }),
        item("c", { groupID: "g2", updated: 7 }),
        item("d", { groupID: "gone", updated: 3 }),
      ],
      filter: all,
    })
    expect(
      sections.map((section) => [section.group?.name ?? UNGROUPED, section.rows.map((row) => row.item.id)]),
    ).toEqual([
      ["Client A", []],
      ["Client B", ["c", "a"]],
      [UNGROUPED, ["b", "d"]],
    ])
  })

  test("subagents sit under their parent; orphans stand alone", () => {
    const sections = build({
      groups: [],
      sessions: [
        item("p"),
        item("k", { kind: "subagent", parentID: "p" }),
        item("o", { kind: "subagent", parentID: "x" }),
      ],
      filter: all,
    })
    const rows = sections[0].rows
    expect(rows.map((row) => [row.item.id, row.children.map((child) => child.id)])).toEqual([
      ["p", ["k"]],
      ["o", []],
    ])
  })

  test("search covers name, project, state and group; a matching subagent keeps its parent", () => {
    const sessions = [
      item("fix login", { groupID: "g1" }),
      item("beta work", { directory: "/work/beta", project: { id: "prj_b", name: "beta", worktree: "/work/beta" } }),
      item("parent"),
      item("needle child", { kind: "subagent", parentID: "parent" }),
    ]
    const find = (search: string) =>
      build({ groups: [group("g1", "Acme")], sessions, filter: { ...all, search } }).flatMap((section) =>
        section.rows.map((row) => [row.item.id, row.children.map((child) => child.id)]),
      )
    expect(find("LOGIN")).toEqual([["fix login", []]])
    expect(find("beta")).toEqual([["beta work", []]])
    expect(find("acme")).toEqual([["fix login", []]])
    expect(find("needle")).toEqual([["parent", ["needle child"]]])
  })

  test("state and group filters", () => {
    const sessions = [
      item("w", { state: "waiting", groupID: "g1" }),
      item("r", { state: "running" }),
      item("f", { state: "failed" }),
    ]
    const ids = (filter: Filter) =>
      build({ groups: [group("g1", "A")], sessions, filter }).flatMap((section) =>
        section.rows.map((row) => row.item.id),
      )
    expect(ids({ ...all, state: "waiting" })).toEqual(["w"])
    expect(ids({ ...all, group: "g1" })).toEqual(["w"])
    expect(ids({ ...all, group: UNGROUPED })).toEqual(["r", "f"])
    expect(waiting(sessions)).toBe(1)
  })

  test("project name falls back to the folder name", () => {
    expect(projectName(item("x", { project: undefined, directory: "/home/me/client-site" }))).toBe("client-site")
    expect(projectName(item("x", { project: undefined, directory: "C:\\work\\win-proj" }))).toBe("win-proj")
  })
})

describe("money (XCOD-235)", () => {
  test("a cost below $0.0001 isn't shown as $0.00", () => {
    expect(money(0, "en-US")).toBe("$0.00")
    expect(money(0.00004, "en-US")).toBe("<$0.0001")
    expect(money(0.0001, "en-US")).toBe("$0.0001")
    expect(money(1.23456, "en-US")).toBe("$1.2346")
  })
})

describe("bulk actions (XCOD-265)", () => {
  // The acceptance mix: 3 running, 2 waiting, 1 Claude Code, 1 in another Lunos, 4 finished/idle/failed.
  const mix = [
    item("r1", { state: "running" }),
    item("r2", { state: "running", groupID: "g1" }),
    item("r3", { state: "running", project: { id: "prj_b", name: "beta", worktree: "/work/beta" } as any }),
    item("w1", { state: "waiting" }),
    item("w2", { state: "waiting", groupID: "g1" }),
    item("external:cc", { kind: "external", tool: "claude", state: "running" }),
    item("p1", { state: "running", elsewhere: true }),
    item("f1", { state: "finished" }),
    item("f2", { state: "idle" }),
    item("f3", { state: "failed" }),
    item("f4", { state: "finished", groupID: "g1" }),
  ]
  const groups = [group("g1", "Client A")]
  const view = (filter: Partial<Filter> = {}) => inView({ groups, sessions: mix, filter: { ...all, ...filter } })

  test("Stop all counts every running and waiting row by kind", () => {
    const plan = stopPlan(view())
    expect(plan.targets.map((row) => row.id).sort()).toEqual(["external:cc", "p1", "r1", "r2", "r3", "w1", "w2"])
    expect([plan.running, plan.waiting, plan.tools, plan.elsewhere]).toEqual([
      4,
      2,
      [{ name: "Claude Code", count: 1 }],
      1,
    ])
    expect(plan.projects).toEqual([
      { key: "/work/alpha", name: "alpha", count: 6 },
      { key: "/work/beta", name: "beta", count: 1 },
    ])
  })

  test("an external row with only its folder counts in the same project as the sessions there", () => {
    const plan = stopPlan([
      item("r", { state: "running" }),
      item("external:x", { kind: "external", tool: "codex", state: "running", project: undefined }),
      item("g", { state: "running", project: { id: "global", worktree: "/" } as any, directory: "/tmp/scratch" }),
    ])
    expect(plan.projects.map((project) => [project.key, project.name, project.count])).toEqual([
      ["/work/alpha", "alpha", 2],
      ["/tmp/scratch", "scratch", 1],
    ])
  })

  test("the view's filters decide what Stop all reaches", () => {
    expect(stopPlan(view({ state: "waiting" })).targets.map((row) => row.id)).toEqual(["w1", "w2"])
    expect(stopPlan(view({ group: "g1" })).targets.map((row) => row.id)).toEqual(["r2", "w2"])
    expect(stopPlan(view({ search: "client a" })).targets.map((row) => row.id)).toEqual(["r2", "w2"])
    // A finished external row isn't stoppable; a waiting one never exists.
    expect(stopPlan([item("external:x", { kind: "external", state: "finished" })]).targets).toEqual([])
  })

  test("Clear archives only finished, idle and failed rows, and counts what stays", () => {
    const plan = clearPlan(view())
    expect(plan.targets.map((row) => row.id)).toEqual(["f1", "f2", "f3", "f4"])
    expect(plan.staying.length).toBe(7)
  })

  test("a subagent goes with its listed parent, and counts on its own under a state filter", () => {
    const sessions = [
      item("p", { state: "finished", groupID: "g1" }),
      item("k", { kind: "subagent", parentID: "p", state: "finished" }),
      item("kw", { kind: "subagent", parentID: "p", state: "waiting" }),
    ]
    expect(clearPlan(sessions).targets.map((row) => row.id)).toEqual(["p"])
    expect(topLevel([sessions[1]!]).map((row) => row.id)).toEqual(["k"])
    // In the parent's group for the group filter; on its own state for the state filter.
    const waitingInGroup = inView({ groups, sessions, filter: { ...all, group: "g1", state: "waiting" } })
    expect(waitingInGroup.map((row) => row.id)).toEqual(["kw"])
  })

  test("the archived view lists archived rows whatever their state", () => {
    const sessions = [
      item("a", { state: "failed", archived: 5, updated: 1 }),
      item("b", { state: "finished", archived: 6, updated: 2 }),
    ]
    expect(inView({ groups: [], sessions, filter: { ...all, state: "archived" } }).map((row) => row.id)).toEqual([
      "a",
      "b",
    ])
    expect(
      build({ groups: [], sessions, filter: { ...all, state: "archived" } })[0]!.rows.map((row) => row.item.id),
    ).toEqual(["b", "a"])
  })
})
