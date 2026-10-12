import { describe, expect, test } from "bun:test"
import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2/client"
import { build, projectName, UNGROUPED, waiting, type Filter } from "./sessions-model"

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
