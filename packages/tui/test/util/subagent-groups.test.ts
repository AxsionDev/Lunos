import { describe, expect, test } from "bun:test"
import type { SubagentState } from "../../src/util/subagent-avatar"
import {
  forgetWaiting,
  GROUPS,
  groupSubagents,
  toggle,
  type GroupItem,
  type Overrides,
} from "../../src/util/subagent-groups"

const item = (id: string, state: SubagentState, extra: Partial<GroupItem> = {}): GroupItem => ({ id, state, ...extra })

/** The ticket's fixture, in launch order: 2 running, 1 queued, 2 waiting, 1 failed, 1 done. */
const fixture = () => [
  item("done1", "done"),
  item("run_new", "running", { started: 2_000 }),
  item("wait1", "waiting"),
  item("queued1", "queued"),
  item("run_old", "running", { started: 1_000 }),
  item("failed1", "failed"),
  item("wait2", "waiting"),
]

const ids = (view: { rows: { item: GroupItem }[] }) => view.rows.map((row) => row.item.id)

// XCOD-299: Working, Waiting for action and Completed, for the sidebar and the Agent Monitor.
describe("subagent groups", () => {
  test("the ticket's fixture: counts, the header and the order inside each sub-section", () => {
    const grouped = groupSubagents(fixture())
    expect(grouped.header).toBe("7 · 2 need you")
    expect(grouped.groups.map((group) => [group.title, group.count])).toEqual([
      ["Working", 3],
      ["Waiting for action", 2],
      ["Completed", 2],
    ])
    const [working, waiting, completed] = grouped.groups
    // Running first, the longest-running at the top, then the queued one.
    expect(ids(working!)).toEqual(["run_old", "run_new", "queued1"])
    expect(ids(waiting!)).toEqual(["wait1", "wait2"])
    // Failed first, then done.
    expect(ids(completed!)).toEqual(["failed1", "done1"])
    expect(completed!.summary).toBe("✕ 1 failed · ✓ 1 done")
    expect(working!.summary).toBe("◐ 2 running · ◌ 1 queued")
    expect(waiting!.label).toBe("Waiting for action, 2")
  })

  test("defaults: Working and Waiting open, Completed open until it holds more than 3", () => {
    expect(groupSubagents(fixture()).groups.map((group) => group.open)).toEqual([true, true, true])
    const many = [...fixture(), item("done2", "done"), item("done3", "done")]
    const grouped = groupSubagents(many)
    expect(grouped.groups.map((group) => group.open)).toEqual([true, true, false])
    expect(grouped.groups[2]!.summary).toBe("✕ 1 failed · ✓ 3 done")
  })

  test("empty sub-sections are still listed, in the same place, collapsed", () => {
    const grouped = groupSubagents([item("a", "done")], { overrides: { working: true } })
    expect(grouped.groups.map((group) => group.group)).toEqual([...GROUPS])
    expect(grouped.groups.map((group) => [group.count, group.empty, group.open])).toEqual([
      [0, true, false],
      [0, true, false],
      [1, false, true],
    ])
    expect(grouped.header).toBe("1")
    // A click on an empty header changes nothing.
    expect(toggle({}, grouped.groups[0]!)).toEqual({})
  })

  test("a subagent moves between sub-sections as its state changes", () => {
    const states: SubagentState[] = ["queued", "running", "waiting", "running", "done"]
    const where = states.map((state) => {
      const grouped = groupSubagents([item("a", state), item("b", "running")])
      return grouped.groups.find((group) => ids(group).includes("a"))!.group
    })
    expect(where).toEqual(["working", "working", "waiting", "working", "completed"])
  })

  test("a collapse is kept, and a new ask reopens Waiting even if it was collapsed", () => {
    const first = groupSubagents(fixture())
    let overrides: Overrides = toggle({}, first.groups[1]!)
    expect(overrides).toEqual({ waiting: false, waitingSeen: ["wait1", "wait2"] })
    overrides = toggle(overrides, first.groups[2]!)

    const collapsed = groupSubagents(fixture(), { overrides })
    expect(collapsed.groups.map((group) => group.open)).toEqual([true, false, false])
    expect(collapsed.reopened).toBe(false)
    // One of the two answered: still collapsed.
    expect(
      groupSubagents(
        fixture().filter((x) => x.id !== "wait2"),
        { overrides },
      ).groups[1]!.open,
    ).toBe(false)

    const asked = groupSubagents([...fixture(), item("wait3", "waiting")], { overrides })
    expect(asked.reopened).toBe(true)
    expect(asked.groups[1]!.open).toBe(true)
    // Completed stays as the user left it.
    expect(asked.groups[2]!.open).toBe(false)
    expect(forgetWaiting(overrides)).toEqual({ completed: false })
  })

  test("nested subagents sit under their parent, in the sub-section of their own state", () => {
    const grouped = groupSubagents([
      item("p", "running", { started: 1 }),
      item("p_child_running", "running", { parent: "p", started: 5 }),
      item("p_child_waiting", "waiting", { parent: "p" }),
      item("grandchild", "running", { parent: "p_child_running", started: 6 }),
      item("q", "running", { started: 2 }),
    ])
    const [working, waiting] = grouped.groups
    expect(working!.rows.map((row) => [row.item.id, row.depth])).toEqual([
      ["p", 0],
      ["p_child_running", 1],
      ["grandchild", 2],
      ["q", 0],
    ])
    // Its parent works, so it's on its own under Waiting.
    expect(waiting!.rows.map((row) => [row.item.id, row.depth])).toEqual([["p_child_waiting", 0]])
  })

  test("the Agent Monitor keeps children under their parent", () => {
    const grouped = groupSubagents(
      [item("p", "waiting"), item("kid", "running", { parent: "p" }), item("x", "failed"), item("y", "done")],
      { nest: "parent" },
    )
    expect(grouped.groups.map((group) => group.rows.map((row) => `${row.item.id}:${row.depth}`))).toEqual([
      [],
      ["p:0", "kid:1"],
      ["x:0", "y:0"],
    ])
  })
})
