// XCOD-265: `lunos session archive --older-than`.
import { describe, expect, test } from "bun:test"
import { archivedTargets, parseAge } from "../../src/cli/cmd/session"

describe("parseAge", () => {
  test("minutes, hours, days and weeks", () => {
    expect(parseAge("30m")).toBe(30 * 60_000)
    expect(parseAge("12h")).toBe(12 * 3_600_000)
    expect(parseAge("7d")).toBe(7 * 86_400_000)
    expect(parseAge("2w")).toBe(14 * 86_400_000)
  })

  test("anything else is refused, not guessed", () => {
    for (const value of ["7", "7x", "d", "-1d", "1.5d", ""]) expect(parseAge(value)).toBeUndefined()
  })
})

// XCOD-284: `lunos session delete --archived [--older-than] [--project]`.
describe("archivedTargets", () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    updated: 1_000,
    directory: "/work/alpha",
    project: { id: "p", name: "alpha", worktree: "/work/alpha" },
    ...extra,
  })
  test("top-level only, older than the cut-off, in the project at the path", () => {
    const items = [
      item("old"),
      item("new", { updated: 5_000 }),
      item("child", { parentID: "old" }),
      item("beta", { directory: "/work/beta", project: { id: "b", name: "beta", worktree: "/work/beta" } }),
      item("alphabet", { directory: "/work/alphabet", project: undefined }),
    ]
    expect(archivedTargets(items, {}).map((x) => x.id)).toEqual(["old", "new", "beta", "alphabet"])
    expect(archivedTargets(items, { before: 2_000 }).map((x) => x.id)).toEqual(["old", "beta", "alphabet"])
    // A sibling folder that shares the prefix is another project.
    expect(archivedTargets(items, { project: "/work/alpha" }).map((x) => x.id)).toEqual(["old", "new"])
  })
})
