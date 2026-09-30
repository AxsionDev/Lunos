import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// XCOD-141: the project's select button is also its drag handle. Enter must keep selecting it and
// Space must pick it up for keyboard reordering, without also toggling the selection.
test("home project row: Enter selects, Space picks up for reordering", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)
  await page.goto("/")
  const row = page.locator('[data-component="home-project-row"]')
  await expectAppVisible(row)
  await expect(row).toHaveAttribute("aria-roledescription", "draggable")
  await expect(row.locator("xpath=..")).not.toHaveAttribute("role", "button")

  await row.focus()
  const selected = await row.getAttribute("data-selected")
  await row.press("Enter")
  if (selected === null) await expect(row).toHaveAttribute("data-selected", "")
  else await expect(row).not.toHaveAttribute("data-selected")
  const after = await row.getAttribute("data-selected")

  await row.press("Space")
  // While dragging, dnd-kit renders a feedback copy of the row next to the original.
  await expect(page.locator('[data-component="home-project-row"][aria-pressed="true"]')).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute("aria-pressed", "false")
  expect(await row.getAttribute("data-selected")).toBe(after)
})
