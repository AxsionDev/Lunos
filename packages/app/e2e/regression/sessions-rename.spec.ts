import { expect, test, type Page } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// XCOD-325: every row of the Sessions window (web /sessions, desktop Sessions window) can be renamed
// from its Rename button, a double-click on its title or its context menu, against a fake server
// that keeps state. Each kind of row goes to its own route: this Lunos's session, a session another
// Lunos runs, and a Claude Code session (its Lunos name only).

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
}

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
    permissions: 0,
    questions: 0,
    ...extra,
  })
  const state = {
    listed: [
      row("ses_own", "Refactor parser", "finished"),
      row("ses_p1", "Long migration", "running", { elsewhere: true }),
      row("external:cc1", "Claude Code · alpha", "finished", { kind: "external", tool: "claude" }),
    ],
    archived: [row("ses_old", "Old spike", "finished", { archived: now - 1000 })],
    calls: [] as { route: string; id: string; body: any }[],
    /** id -> [status, body] the next rename of it answers with. */
    failNext: {} as Record<string, [number, object]>,
  }
  const rename = (kind: string, id: string) => async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors })
    const body = route.request().postDataJSON()
    state.calls.push({ route: kind, id, body })
    const failure = state.failNext[id]
    if (failure) {
      delete state.failNext[id]
      return route.fulfill({ status: failure[0], json: failure[1], headers: cors })
    }
    const item = [...state.listed, ...state.archived].find((each) => each.id === id)!
    item.title = body.title || `automatic ${id}`
    return route.fulfill({ json: kind === "session" ? item : true, headers: cors })
  }

  const routes = async () => {
    await page.route(/\/experimental\/session-overview(?:\?.*)?$/, (route) => {
      const archived = new URL(route.request().url()).searchParams.get("archived") === "true"
      return route.fulfill({ json: { groups: [], sessions: archived ? state.archived : state.listed }, headers: cors })
    })
    await page.route(/\/experimental\/external\/([^/?]+)\/rename(?:\?.*)?$/, (route) => {
      const id = /\/external\/([^/?]+)\/rename/.exec(route.request().url())![1]!
      return rename("external", `external:${id}`)(route)
    })
    await page.route(/\/experimental\/peer\/([^/?]+)\/rename(?:\?.*)?$/, (route) => {
      const id = /\/peer\/([^/?]+)\/rename/.exec(route.request().url())![1]!
      return rename("peer", id)(route)
    })
    await page.route(/\/session\/ses_[a-z0-9]+(?:\?.*)?$/, (route) => {
      if (!["PATCH", "OPTIONS"].includes(route.request().method())) return route.fallback()
      const id = /\/session\/(ses_[a-z0-9]+)/.exec(route.request().url())![1]!
      return rename("session", id)(route)
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

const rowOf = (page: Page, id: string) => page.locator(`[data-session-id="${id}"]`)
const nameField = (page: Page, id: string) => rowOf(page, id).getByRole("textbox", { name: "Session name" })

test("a Claude Code row has Rename: its Lunos name is saved through its own route", async ({ page }) => {
  const state = await open(page)
  // Prefilled with the current name.
  await rowOf(page, "external:cc1").getByRole("button", { name: "Rename", exact: true }).click()
  await expect(nameField(page, "external:cc1")).toHaveValue("Claude Code · alpha")
  await nameField(page, "external:cc1").fill("API work")
  await page.keyboard.press("Enter")
  await expect(rowOf(page, "external:cc1").getByText("API work", { exact: true })).toBeVisible()
  expect(state.calls).toEqual([{ route: "external", id: "external:cc1", body: { title: "API work" } }])
})

test("another Lunos's row: a double-click on the title edits it, and that Lunos is asked to save it", async ({
  page,
}) => {
  const state = await open(page)
  await rowOf(page, "ses_p1").getByText("Long migration", { exact: true }).dblclick()
  await nameField(page, "ses_p1").fill("Theirs")
  await page.keyboard.press("Enter")
  await expect(rowOf(page, "ses_p1").getByText("Theirs", { exact: true })).toBeVisible()
  expect(state.calls).toEqual([{ route: "peer", id: "ses_p1", body: { title: "Theirs" } }])
})

test("the row's context menu offers Rename; Esc cancels, Enter saves", async ({ page }) => {
  const state = await open(page)
  await rowOf(page, "ses_own").getByText("Refactor parser", { exact: true }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename" }).click()
  await expect(nameField(page, "ses_own")).toBeFocused()
  await nameField(page, "ses_own").fill("Never saved")
  await page.keyboard.press("Escape")
  await expect(nameField(page, "ses_own")).toHaveCount(0)
  await expect(rowOf(page, "ses_own").getByText("Refactor parser", { exact: true })).toBeVisible()
  expect(state.calls).toEqual([])

  await rowOf(page, "ses_own").getByText("Refactor parser", { exact: true }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename" }).click()
  await nameField(page, "ses_own").fill("Parser v2")
  await page.keyboard.press("Enter")
  await expect(rowOf(page, "ses_own").getByText("Parser v2", { exact: true })).toBeVisible()
  expect(state.calls).toEqual([{ route: "session", id: "ses_own", body: { title: "Parser v2" } }])
})

test("a rename that can't be saved keeps the old name and the row says why", async ({ page }) => {
  const state = await open(page)
  state.failNext = {
    ses_p1: [400, { name: "InvalidRequestError", message: "the Lunos running it isn't responding" }],
    "external:cc1": [404, { name: "NotFoundError", data: { message: "That session was deleted." } }],
  }
  await rowOf(page, "ses_p1").getByRole("button", { name: "Rename", exact: true }).click()
  await nameField(page, "ses_p1").fill("Theirs")
  await page.keyboard.press("Enter")
  await expect(rowOf(page, "ses_p1").getByRole("status")).toHaveText(
    "Couldn't rename: the Lunos running it isn't responding",
  )
  await expect(rowOf(page, "ses_p1").getByText("Long migration", { exact: true })).toBeVisible()

  await rowOf(page, "external:cc1").getByRole("button", { name: "Rename", exact: true }).click()
  await nameField(page, "external:cc1").fill("Gone")
  await page.keyboard.press("Enter")
  await expect(rowOf(page, "external:cc1").getByRole("status")).toHaveText("Couldn't rename: the session was deleted")
  await expect(rowOf(page, "external:cc1").getByText("Claude Code · alpha", { exact: true })).toBeVisible()

  // A later rename that works clears the message.
  await rowOf(page, "ses_p1").getByRole("button", { name: "Rename", exact: true }).click()
  await nameField(page, "ses_p1").fill("Theirs")
  await page.keyboard.press("Enter")
  await expect(rowOf(page, "ses_p1").getByText("Theirs", { exact: true })).toBeVisible()
  await expect(rowOf(page, "ses_p1").getByRole("status")).toHaveCount(0)
})

test("an archived session can be renamed from Show archived", async ({ page }) => {
  const state = await open(page)
  await page.getByRole("button", { name: "Show archived" }).click()
  await expect(page.getByText("Old spike", { exact: true })).toBeVisible()
  await rowOf(page, "ses_old").getByRole("button", { name: "Rename", exact: true }).click()
  await nameField(page, "ses_old").fill("Old spike, kept")
  await page.keyboard.press("Enter")
  await expect(rowOf(page, "ses_old").getByText("Old spike, kept", { exact: true })).toBeVisible()
  expect(state.calls).toEqual([{ route: "session", id: "ses_old", body: { title: "Old spike, kept" } }])
})
