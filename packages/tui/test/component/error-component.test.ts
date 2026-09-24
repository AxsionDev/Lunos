import { describe, expect, test } from "bun:test"
import { buildIssueURL } from "../../src/component/error-component"

describe("crash screen issue link", () => {
  const url = buildIssueURL("boom", "Error: boom\n    at x (y.ts:1:1)")

  test("opens a pre-filled bug report on the Lunos repo, not upstream", () => {
    expect(url.origin + url.pathname).toBe("https://github.com/AxsionDev/Lunos/issues/new")
    expect(url.searchParams.get("template")).toBe("bug-report.yml")
  })

  test("fills the Lunos version field the issue template declares", async () => {
    const template = await Bun.file(
      new URL("../../../../.github/ISSUE_TEMPLATE/bug-report.yml", import.meta.url),
    ).text()
    expect(template).toContain("id: lunos-version")
    expect(url.searchParams.get("lunos-version")).toStartWith("Lunos ")
    // Every pre-filled key must exist as a field id, or GitHub silently drops it.
    for (const key of url.searchParams.keys()) {
      if (key === "template" || key === "title") continue
      expect(template).toContain(`id: ${key}`)
    }
  })

  test("says Lunos, not opencode, in the report text", () => {
    expect(url.searchParams.get("description")).toContain("The Lunos TUI crashed")
    for (const key of ["title", "description", "reproduce"]) {
      expect(url.searchParams.get(key)!.toLowerCase()).not.toContain("opencode")
    }
  })
})
