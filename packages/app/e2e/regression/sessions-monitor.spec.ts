import { expect, test, type Page } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// XCOD-262: the Sessions window's Agent Monitor layout (web /sessions, desktop Sessions window): the
// rail by status on the right, and the composer in the centre that starts a session or sends to the
// sessions tagged with @. Against a fake server; the request bodies prove where each prompt went.

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
  // Rail order and numbers: Waiting 1, Running 2-4, Completed 5 (its Lunos stopped) and 6, Failed 7.
  const listed = [
    row("ses_w1", "Deploy script", "waiting", { updated: now - 1000 }),
    row("ses_r1", "Refactor parser", "running", { updated: now - 2000 }),
    row("ses_p1", "Long migration", "running", { elsewhere: true, updated: now - 3000 }),
    row("external:cc1", "Claude Code · alpha", "running", { kind: "external", tool: "claude", updated: now - 4000 }),
    row("ses_s1", "Crashed run", "idle", { stale: true, updated: now - 5000 }),
    row("ses_f1", "Fix typo", "finished", { updated: now - 6000 }),
    row("ses_x1", "Flaky test", "failed", { updated: now - 7000 }),
    row("ses_old", "Last week's spike", "finished", { updated: now - 7 * 24 * 60 * 60 * 1000 }),
  ]
  const state = { listed, calls: [] as { path: string; body: any }[], created: 0 }
  const permission = {
    id: "per_1",
    sessionID: "ses_w1",
    permission: "bash",
    patterns: ["git push origin main"],
    metadata: {},
    always: [],
  }

  const routes = async () => {
    await page.route(/\/experimental\/session-overview(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { groups: [], sessions: state.listed }, headers: cors }),
    )
    await page.route(
      /\/(experimental\/(session|peer)\/[^/]+\/(enqueue|prompt)|permission\/[^/]+\/reply|session)(?:\?.*)?$/,
      (route) => {
        const request = route.request()
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*" } })
        if (request.method() !== "POST") return route.fallback()
        const path = new URL(request.url()).pathname
        const body = request.postDataJSON()
        state.calls.push({ path, body })
        if (path === "/session") {
          const id = `ses_new${++state.created}`
          state.listed.push(row(id, "New session", "running", { updated: Date.now() }))
          return route.fulfill({
            json: {
              id,
              slug: id,
              projectID: "prj_a",
              directory: fixture.directory,
              title: "New session",
              version: "1",
              time: { created: 1, updated: 1 },
            },
            headers: cors,
          })
        }
        if (path.startsWith("/permission/")) return route.fulfill({ json: true, headers: cors })
        const id = path.split("/")[3]
        const running = state.listed.find((item) => item.id === id)?.state === "running"
        return route.fulfill({
          json: { delivery: running ? (body.interrupt ? "interrupted" : "queued") : "now" },
          headers: cors,
        })
      },
    )
  }
  return { state, routes, permission }
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
    permissions: [fake.permission],
  })
  await fake.routes()
  await page.goto("/sessions")
  await expectAppVisible(page.getByText("Refactor parser", { exact: true }))
  return fake.state
}

const rail = (page: Page) => page.getByRole("complementary", { name: "Sessions on this computer" })
const prompt = (page: Page) => page.getByRole("combobox", { name: "Prompt" })
const sent = (state: { calls: { path: string }[] }, pattern: RegExp) =>
  state.calls.filter((call) => pattern.test(call.path))

async function send(page: Page, text: string) {
  await prompt(page).fill(text)
  await prompt(page).press("Enter")
}

test("the rail: Waiting first with its ask, then Running, Completed and Failed, counted and numbered", async ({
  page,
}) => {
  await open(page)
  const headings = rail(page).getByRole("heading", { level: 2 })
  await expect(headings).toHaveText(["Waiting for you (1)", "Running (3)", "Completed (2)", "Failed (1)"])
  const waiting = page.locator('[data-session-id="ses_w1"]')
  await expect(waiting.getByText("Approve: bash git push origin main")).toBeVisible()
  await expect(waiting.getByRole("button", { name: "Tag @1 Deploy script in the prompt" })).toHaveText("1")
  await expect(page.locator('[data-session-id="ses_x1"]').getByRole("button", { name: /^Tag @7 / })).toBeVisible()
  // Completed in the last 24 h only; older ones are behind Show older.
  await expect(page.getByText("Last week's spike", { exact: true })).toHaveCount(0)
  await rail(page).getByRole("button", { name: "Show older (1)" }).click()
  await expect(page.getByText("Last week's spike", { exact: true })).toBeVisible()
  // By group is the list as before.
  await rail(page).getByRole("button", { name: "By group" }).click()
  await expect(rail(page).getByRole("heading", { name: "Ungrouped" })).toBeVisible()
})

test("an untagged prompt starts a session in the chosen project and the window stays", async ({ page }) => {
  const state = await open(page)
  await expect(page.getByRole("combobox", { name: "New sessions in" })).toHaveValue(fixture.directory)
  await send(page, "write the release notes")
  await expect(page.getByText("Started a session in alpha")).toBeVisible()
  expect(sent(state, /^\/session$/)).toHaveLength(1)
  expect(sent(state, /enqueue$/)).toEqual([
    { path: "/experimental/session/ses_new1/enqueue", body: { text: "write the release notes" } },
  ])
  await expect(prompt(page)).toHaveValue("")
  await expect(rail(page).getByText("New session", { exact: true })).toBeVisible()
})

test("@n sends to that session with a chip; a running one queues it, Ctrl+Enter interrupts", async ({ page }) => {
  const state = await open(page)
  await prompt(page).fill("@2 run the tests")
  await expect(page.getByText("@2 Refactor parser", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("To: @2 Refactor parser")).toBeVisible()
  await prompt(page).press("Enter")
  await expect(page.getByText('Queued for "Refactor parser"')).toBeVisible()
  expect(state.calls).toEqual([
    { path: "/experimental/session/ses_r1/enqueue", body: { text: "run the tests", interrupt: false } },
  ])
  await expect(prompt(page)).toHaveValue("")

  await prompt(page).fill("@2 stop and fix the build")
  await prompt(page).press("Control+Enter")
  await expect.poll(() => state.calls.length).toBe(2)
  expect(state.calls[1]!.body).toEqual({ text: "stop and fix the build", interrupt: true })
  await expect(prompt(page)).toHaveValue("")

  // A row's number puts its tag in the prompt; the chip's × takes it out.
  await page
    .locator('[data-session-id="ses_f1"]')
    .getByRole("button", { name: /^Tag @6 / })
    .click()
  await expect(prompt(page)).toHaveValue("@6 ")
  await page.getByRole("button", { name: "Remove @6 Fix typo" }).click()
  await expect(prompt(page)).toHaveValue("")

  await send(page, "@42 hello")
  await expect(page.getByText("No session @42 in the list")).toBeVisible()
  expect(state.calls).toHaveLength(2)
})

test("@ and part of a name lists the sessions; the pick becomes its number", async ({ page }) => {
  const state = await open(page)
  await prompt(page).pressSequentially("@fix")
  const option = page.getByRole("option", { name: /@6 Fix typo/ })
  await expect(option).toBeVisible()
  // Claude Code rows with no Lunos session aren't offered.
  await prompt(page).fill("@claude")
  await prompt(page).press("End")
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await prompt(page).fill("")
  await prompt(page).pressSequentially("@fix")
  await prompt(page).press("Enter")
  await expect(prompt(page)).toHaveValue("@6 ")
  await prompt(page).pressSequentially("summarise it")
  await prompt(page).press("Enter")
  await expect.poll(() => state.calls.length).toBe(1)
  expect(state.calls[0]).toEqual({
    path: "/experimental/session/ses_f1/enqueue",
    body: { text: "summarise it", interrupt: false },
  })
})

test("tagging three sessions asks first; cancelling sends nothing, confirming sends to each", async ({ page }) => {
  const state = await open(page)
  await send(page, "@2 @6 @7 rebase on dev")
  const dialog = page.locator('[data-component="sessions-bulk-confirm"]')
  await expect(page.getByRole("heading", { name: "Send to 3 sessions?" })).toBeVisible()
  await expect(dialog).toContainText("@2 Refactor parser, @6 Fix typo, @7 Flaky test")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  expect(state.calls).toHaveLength(0)
  await expect(prompt(page)).toHaveValue("@2 @6 @7 rebase on dev")

  await prompt(page).press("Enter")
  await dialog.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Sent: 2 · Queued: 1")).toBeVisible()
  expect(state.calls.map((call) => call.path).toSorted()).toEqual(
    ["ses_r1", "ses_f1", "ses_x1"].map((id) => `/experimental/session/${id}/enqueue`).toSorted(),
  )
})

test("another Lunos's session gets it through peer.prompt; a stopped one asks to take it over", async ({ page }) => {
  const state = await open(page)
  await send(page, "@3 check the logs")
  await expect.poll(() => state.calls.length).toBe(1)
  expect(state.calls[0]).toEqual({
    path: "/experimental/peer/ses_p1/prompt",
    body: { text: "check the logs", interrupt: false },
  })
  await expect(prompt(page)).toHaveValue("")

  await send(page, "@5 carry on")
  await expect(page.getByRole("heading", { name: "Take over this session here?" })).toBeVisible()
  await page.getByRole("button", { name: "Take over" }).click()
  await expect.poll(() => state.calls.length).toBe(2)
  expect(state.calls[1]).toEqual({
    path: "/experimental/session/ses_s1/enqueue",
    body: { text: "carry on", interrupt: false },
  })
})

test("a prompt never approves a tool call; Approve on the row does, once", async ({ page }) => {
  const state = await open(page)
  await send(page, "@1 yes, go ahead")
  await expect.poll(() => state.calls.length).toBe(1)
  expect(state.calls[0]!.path).toBe("/experimental/session/ses_w1/enqueue")
  await expect(prompt(page)).toHaveValue("")
  expect(sent(state, /permission/)).toHaveLength(0)

  await page.locator('[data-session-id="ses_w1"]').getByRole("button", { name: "Approve", exact: true }).click()
  await expect(page.getByText("Approved: bash git push origin main")).toBeVisible()
  expect(sent(state, /permission/)).toEqual([{ path: "/permission/per_1/reply", body: { reply: "once" } }])

  // A Claude Code session with no Lunos session isn't sent anything from here.
  await send(page, "@4 hi")
  await expect(
    page.getByText('"Claude Code · alpha" runs in Claude Code: open it there to send it a prompt'),
  ).toBeVisible()
  expect(state.calls).toHaveLength(2)
})
