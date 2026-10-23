import { describe, expect, test } from "bun:test"
import { isDefaultTitle, RENAME_MAX, renameValue } from "../../src/util/session"

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  // XCOD-308: what every rename surface (/rename, the sidebar, /sessions, the Agent Monitor) sends.
  test("a rename is one trimmed line of at most 80 characters", () => {
    expect(renameValue("  Release   notes \n", "Old")).toBe("Release notes")
    expect(renameValue("line one\nline two", "Old")).toBe("line one line two")
    expect(renameValue("a".repeat(100), "Old")).toBe("a".repeat(RENAME_MAX))
  })

  test("an unchanged or cancelled rename sends nothing; an empty one goes back to the automatic name", () => {
    expect(renameValue("Same", "Same")).toBeUndefined()
    expect(renameValue(" Same ", "Same")).toBeUndefined()
    expect(renameValue(null, "Same")).toBeUndefined()
    expect(renameValue(undefined, "Same")).toBeUndefined()
    expect(renameValue("   ", "Mine")).toBe("")
  })
})
