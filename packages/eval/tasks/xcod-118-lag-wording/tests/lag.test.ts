import { expect, test } from "bun:test"
import { badge, describeLag } from "/app/lag"

test("one day is singular", () => {
  expect(describeLag({ commits: 5, days: 1 })).toBe("1 day behind upstream (5 commits)")
  expect(badge({ commits: 5, days: 1 }).message).toBe("1 day (5 commits)")
})

test("everything else is unchanged", () => {
  expect(describeLag({ commits: 63, days: 8 })).toBe("8 days behind upstream (63 commits)")
  expect(describeLag({ commits: 3, days: 0 })).toBe("0 days behind upstream (3 commits)")
  expect(describeLag({ commits: 0, days: 0 })).toBe("up to date with upstream")
  expect(badge({ commits: 63, days: 8 })).toEqual({
    schemaVersion: 1,
    label: "behind upstream",
    message: "8 days (63 commits)",
    color: "yellow",
  })
  expect(badge({ commits: 0, days: 0 }).message).toBe("up to date")
  expect(badge({ commits: 5, days: 15 }).color).toBe("red")
})
