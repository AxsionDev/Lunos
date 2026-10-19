import { expect, test, type Page } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// XCOD-265: the Sessions window's (web /sessions, desktop Sessions window) bulk actions, against a
// fake server that keeps state. The request bodies prove what each action reaches.

const cors = { "access-control-allow-origin": "*" }

function setup(page: Page) {
  const now = Date.now()
  const row = (id: string, title: string, state: string, extra: object = {}) => ({
    id,
    kind: "session",
    title,
    directory: fixture.directory,
    project: { id: "prj_a", name: "alpha", worktree: fixture.directory },
    cost: 0,
    created: now - 60_000,
    updated: now - 30_000,
    state,
    permissions: state === "waiting" ? 1 : 0,
    questions: 0,
    ...extra,
  })
  // The acceptance mix: 3 running, 2 waiting, 1 Claude Code, 1 in another Lunos, 4 finished.
  const listed = [
    row("ses_r1", "Refactor parser", "running", { groupID: "grp_a" }),
    row("ses_r2", "Write docs", "running"),
    row("ses_r3", "Port to beta", "running", { project: { id: "prj_b", name: "beta", worktree: "/work/beta" } }),
    row("ses_w1", "Deploy script", "waiting"),
    row("ses_w2", "Rotate keys", "waiting", { groupID: "grp_a" }),
    row("external:cc1", "Claude Code · alpha", "running", { kind: "external", tool: "claude" }),
    row("ses_p1", "Long migration", "running", { elsewhere: true }),
    row("ses_f1", "Fix typo", "finished"),
    row("ses_f2", "Explore API", "idle"),
    row("ses_f3", "Flaky test", "failed"),
    row("ses_f4", "Old spike", "finished", { groupID: "grp_a" }),
  ]
  const state = {
    listed,
    archived: [] as typeof listed,
    calls: [] as { path: string; body: any }[],
    // What the next stop reports as failed, id -> reason.
    failNext: {} as Record<string, string>,
  }
  const groups = [{ id: "grp_a", name: "Client A", collapsed: false, created: now, updated: now }]
  const archive = (ids: string[]) => {
    const moved = state.listed.filter((item) => ids.includes(item.id))
    state.listed = state.listed.filter((item) => !ids.includes(item.id))
    state.archived.push(...moved.map((item) => ({ ...item, state: "finished", archived: Date.now() })))
    return moved.map((item) => item.id)
  }
  const restore = (ids: string[]) => {
    const moved = state.archived.filter((item) => ids.includes(item.id))
    state.archived = state.archived.filter((item) => !ids.includes(item.id))
    state.listed.push(...moved.map(({ archived: _, ...item }) => item))
    return moved.map((item) => item.id)
  }

  const routes = async () => {
    await page.route(/\/experimental\/session-overview(?:\?.*)?$/, (route) => {
      const archived = new URL(route.request().url()).searchParams.get("archived") === "true"
      return route.fulfill({
        json: { groups, sessions: archived ? state.archived : state.listed },
        headers: cors,
      })
    })
    await page.route(/\/experimental\/session-bulk\/(stop|archive|unarchive|delete)(?:\?.*)?$/, (route) => {
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*" } })
      const path = new URL(route.request().url()).pathname.split("/").pop()!
      const body = route.request().postDataJSON()
      state.calls.push({ path, body })
      const ids: string[] = body.sessionIDs
      if (path === "stop" || (path === "archive" && body.stop)) {
        const failed = ids.filter((id) => state.failNext[id]).map((id) => ({ id, reason: state.failNext[id]! }))
        // As the server: only running and waiting rows are stopped; the rest are just archived.
        const busy = (id: string) =>
          state.listed.some((item) => item.id === id && (item.state === "running" || item.state === "waiting"))
        const stopped = ids.filter((id) => busy(id) && !state.failNext[id])
        state.failNext = {}
        for (const item of state.listed) if (stopped.includes(item.id)) item.state = "idle"
        if (path === "stop") return route.fulfill({ json: { stopped, failed }, headers: cors })
        const archived = archive(ids.filter((id) => !failed.some((item) => item.id === id)))
        return route.fulfill({ json: { archived, skipped: [], stopped, failed }, headers: cors })
      }
      if (path === "archive") return route.fulfill({ json: { archived: archive(ids), skipped: [] }, headers: cors })
      if (path === "unarchive") return route.fulfill({ json: { archived: restore(ids), skipped: [] }, headers: cors })
      const deleted = state.archived.filter((item) => ids.includes(item.id)).map((item) => item.id)
      state.archived = state.archived.filter((item) => !ids.includes(item.id))
      return route.fulfill({ json: { deleted, skipped: [] }, headers: cors })
    })
  }
  return { state, routes }
}

async function open(page: Page) {
  const fake = setup(page)
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await fake.routes()
  await page.goto("/sessions")
  await expectAppVisible(page.getByText("Refactor parser", { exact: true }))
  return fake.state
}

const dialog = (page: Page) => page.locator('[data-component="sessions-bulk-confirm"]')
const sorted = (ids: string[]) => ids.toSorted()

test("Stop all asks once with the counts, stops all 7 and marks the one that failed", async ({ page }) => {
  const state = await open(page)
  state.failNext = { ses_p1: "another Lunos didn't respond" }
  await page.getByRole("button", { name: "Stop all", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Stop 7 sessions?" })).toBeVisible()
  await expect(dialog(page)).toContainText("4 running, 2 waiting for an answer, 1 Claude Code.")
  await expect(dialog(page)).toContainText("1 of them runs in another Lunos window.")
  // Two projects in view: Stop all can be kept to one.
  await expect(dialog(page).getByRole("combobox")).toContainText("All projects (7)")
  // The confirm button is the default.
  await expect(dialog(page).getByRole("button", { name: "Stop 7" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Stopped 6 · 1 couldn't be stopped (another Lunos didn't respond)")).toBeVisible()
  expect(state.calls).toHaveLength(1)
  expect(state.calls[0]!.path).toBe("stop")
  expect(sorted(state.calls[0]!.body.sessionIDs)).toEqual(
    sorted(["ses_r1", "ses_r2", "ses_r3", "ses_w1", "ses_w2", "external:cc1", "ses_p1"]),
  )
  await expect(
    page.locator('[data-session-id="ses_p1"]').getByText("Couldn't stop: another Lunos didn't respond"),
  ).toBeVisible()
})

test("Stop all in one project only, and Esc cancels without a request", async ({ page }) => {
  const state = await open(page)
  await page.getByRole("button", { name: "Stop all", exact: true }).click()
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
  expect(state.calls).toHaveLength(0)

  await page.getByRole("button", { name: "Stop all", exact: true }).click()
  await dialog(page).getByRole("combobox").selectOption({ label: "This project only: beta (1)" })
  await dialog(page).getByRole("button", { name: "Stop 1" }).click()
  await expect(page.getByText("Stopped 1", { exact: true })).toBeVisible()
  expect(state.calls[0]!.body.sessionIDs).toEqual(["ses_r3"])
})

test("Stop all with the filter on waiting stops only the waiting sessions", async ({ page }) => {
  const state = await open(page)
  await page.getByRole("combobox", { name: "State" }).selectOption("waiting")
  await page.getByRole("button", { name: "Stop all", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Stop 2 sessions?" })).toBeVisible()
  await expect(dialog(page)).toContainText("2 waiting for an answer.")
  await dialog(page).getByRole("button", { name: "Stop 2" }).click()
  await expect(page.getByText("Stopped 2", { exact: true })).toBeVisible()
  expect(sorted(state.calls[0]!.body.sessionIDs)).toEqual(["ses_w1", "ses_w2"])
})

test("Clear archives only finished, idle and failed rows; Undo brings them back", async ({ page }) => {
  const state = await open(page)
  await page.getByRole("button", { name: "Clear list", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Clear 4 sessions from the list?" })).toBeVisible()
  await expect(dialog(page)).toContainText("They're archived, not deleted: Show archived brings them back.")
  await expect(dialog(page)).toContainText("7 running sessions stay; stop them first, or use Stop all & clear.")
  await dialog(page).getByRole("button", { name: "Clear 4" }).click()
  await expect(page.getByText("Cleared 4 from the list")).toBeVisible()
  expect(state.calls[0]!.path).toBe("archive")
  expect(state.calls[0]!.body.stop).toBeUndefined()
  expect(sorted(state.calls[0]!.body.sessionIDs)).toEqual(["ses_f1", "ses_f2", "ses_f3", "ses_f4"])
  await expect(page.getByText("Fix typo", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Refactor parser", { exact: true })).toBeVisible()

  await page.getByRole("toolbar").getByRole("button", { name: "Undo", exact: true }).click()
  await expect(page.getByText("Brought back 4")).toBeVisible()
  expect(state.calls[1]!.path).toBe("unarchive")
  expect(sorted(state.calls[1]!.body.sessionIDs)).toEqual(["ses_f1", "ses_f2", "ses_f3", "ses_f4"])
  await expect(page.getByText("Fix typo", { exact: true })).toBeVisible()
  await expect(page.getByRole("toolbar").getByRole("button", { name: "Undo", exact: true })).toHaveCount(0)
})

test("Stop all & clear lists both steps in one confirmation", async ({ page }) => {
  const state = await open(page)
  await page.getByRole("button", { name: "Stop all & clear", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Stop 7 sessions and clear 11 from the list?" })).toBeVisible()
  await expect(dialog(page)).toContainText(
    "1. Stop 4 running, 2 waiting for an answer, 1 Claude Code (1 in another Lunos window).",
  )
  await expect(dialog(page)).toContainText(
    "2. Archive all 11: they're hidden, not deleted, and Show archived brings them back.",
  )
  await dialog(page).getByRole("button", { name: "Stop 7 and clear 11" }).click()
  // One toast: what was stopped, then what was cleared.
  await expect(page.getByText(/^Stopped 7/)).toBeVisible()
  await expect(page.getByText("Cleared 11 from the list")).toBeVisible()
  expect(state.calls).toHaveLength(1)
  expect(state.calls[0]!.body.stop).toBe(true)
  expect(state.calls[0]!.body.sessionIDs).toHaveLength(11)
  await expect(page.getByText("No sessions match")).toBeVisible()
})

test("Show archived lists them, Unarchive restores one, Delete archived needs the typed count", async ({ page }) => {
  const state = await open(page)
  await page.getByRole("button", { name: "Clear list", exact: true }).click()
  await dialog(page).getByRole("button", { name: "Clear 4" }).click()
  await expect(page.getByText("Fix typo", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Show archived" }).click()
  await expect(page.getByRole("heading", { name: "Archived sessions" })).toBeVisible()
  await expect(page.getByText("Fix typo", { exact: true })).toBeVisible()
  await expect(page.getByText("Refactor parser", { exact: true })).toHaveCount(0)
  // Only archived rows' actions here: no Stop all or Clear.
  await expect(page.getByRole("button", { name: "Stop all", exact: true })).toHaveCount(0)

  await page.locator('[data-session-id="ses_f1"]').getByRole("button", { name: "Unarchive" }).click()
  await expect(page.getByText('"Fix typo" is back in the list')).toBeVisible()
  expect(state.calls.at(-1)).toEqual({ path: "unarchive", body: { sessionIDs: ["ses_f1"] } })
  await expect(page.getByText("Fix typo", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Delete archived" }).click()
  await expect(page.getByRole("heading", { name: "Delete 3 archived sessions?" })).toBeVisible()
  await expect(dialog(page)).toContainText("Their history is deleted for good; this can't be undone.")
  await expect(dialog(page)).toContainText("Projects: alpha")
  const confirm = dialog(page).getByRole("button", { name: "Delete 3" })
  await expect(confirm).toBeDisabled()
  await dialog(page).getByRole("textbox", { name: "Type 3 to confirm" }).fill("2")
  await expect(confirm).toBeDisabled()
  await dialog(page).getByRole("textbox", { name: "Type 3 to confirm" }).fill("3")
  await confirm.click()
  await expect(page.getByText("Deleted 3 for good")).toBeVisible()
  expect(state.calls.at(-1)!.path).toBe("delete")
  expect(sorted(state.calls.at(-1)!.body.sessionIDs)).toEqual(["ses_f2", "ses_f3", "ses_f4"])
  await expect(page.getByText("No archived sessions")).toBeVisible()

  await page.getByRole("button", { name: "Back to list" }).click()
  await expect(page.getByText("Fix typo", { exact: true })).toBeVisible()
  await expect(page.getByText("Refactor parser", { exact: true })).toBeVisible()
})
