import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// XCOD-267: the full session view asks "Take over this session here?" before the first prompt in a
// session a closed Lunos left prompts queued for, with the Agent Monitor's options. Against a fake
// server; the request bodies prove what was sent, and in what order.

const cors = { "access-control-allow-origin": "*" }
const session = fixture.sessions[0]!

async function open(page: Page, input: { orphaned: number; v2?: boolean }) {
  const state = { orphaned: input.orphaned, calls: [] as { path: string; body: any }[] }
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((item) => ({ ...item })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.route(/\/experimental\/session\/[^/]+\/queued(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { orphaned: state.orphaned }, headers: cors }),
  )
  await page.route(/\/(experimental\/session\/[^/]+\/takeover|session\/[^/]+\/prompt_async)(?:\?.*)?$/, (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*" } })
    const path = new URL(request.url()).pathname
    const body = request.postDataJSON()
    state.calls.push({ path, body })
    if (path.endsWith("/takeover")) {
      if (body.queued === "discard") state.orphaned = 0
      return route.fulfill({
        json: { sent: body.queued === "send" ? 2 : 0, discarded: body.queued === "discard" ? 2 : 0 },
        headers: cors,
      })
    }
    return route.fulfill({ status: 204, headers: cors })
  })
  if (input.v2)
    await page.addInitScript(() =>
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } })),
    )
  await page.goto(`/${base64Encode(fixture.directory)}/session/${session.id}`)
  const editor = page.locator('[data-component="prompt-input"]').first()
  await expectAppVisible(editor)
  return { state, editor }
}

async function type(page: Page, editor: ReturnType<Page["locator"]>, text: string) {
  await editor.click()
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
}

const dialog = (page: Page) => page.locator('[data-component="sessions-bulk-confirm"]')

for (const v2 of [false, true])
  test(`${v2 ? "new layout: " : ""}the session view asks first; Cancel keeps the text, Send sends it after the queued ones`, async ({
    page,
  }) => {
    const { state, editor } = await open(page, { orphaned: 2, v2 })
    await type(page, editor, "carry on")
    await expect(page.getByRole("heading", { name: "Take over this session here?" })).toBeVisible()
    await expect(dialog(page)).toContainText("Queued: 2.")
    await expect(dialog(page).getByRole("combobox", { name: "Queued prompts" })).toHaveValue("send")

    // Cancel: nothing is sent, and the typed text stays.
    await page.keyboard.press("Escape")
    await expect(dialog(page)).toHaveCount(0)
    expect(state.calls).toHaveLength(0)
    await expect(editor).toContainText("carry on")

    // Send them first (the default): the typed prompt goes with the take-over, behind them.
    await editor.click()
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await dialog(page).getByRole("button", { name: "Take over" }).click()
    await expect.poll(() => state.calls.length).toBe(1)
    expect(state.calls[0]!.path).toBe(`/experimental/session/${session.id}/takeover`)
    expect(state.calls[0]!.body).toMatchObject({
      queued: "send",
      origin: "session",
      text: "carry on",
      request: {
        kind: "prompt",
        body: {
          agent: "build",
          model: { providerID: "opencode", modelID: "claude-opus-4-6" },
          parts: [{ type: "text", text: "carry on" }],
        },
      },
    })
    // Not also sent on its own, ahead of the queued ones.
    await page.waitForTimeout(300)
    expect(state.calls.filter((call) => call.path.endsWith("/prompt_async"))).toHaveLength(0)
    await expect(editor).not.toContainText("carry on")
  })

test("Discard drops the queued prompts, then the typed one is sent as usual", async ({ page }) => {
  const { state, editor } = await open(page, { orphaned: 2 })
  await type(page, editor, "start over")
  await dialog(page).getByRole("combobox", { name: "Queued prompts" }).selectOption({ label: "Discard them (2)" })
  await dialog(page).getByRole("button", { name: "Take over" }).click()
  await expect.poll(() => state.calls.length).toBe(2)
  expect(state.calls[0]).toEqual({
    path: `/experimental/session/${session.id}/takeover`,
    body: { queued: "discard", origin: "session" },
  })
  expect(state.calls[1]!.path).toBe(`/session/${session.id}/prompt_async`)
  expect(state.calls[1]!.body.parts).toEqual([expect.objectContaining({ type: "text", text: "start over" })])
})

test("a session with nothing a closed Lunos queued is sent to with no question", async ({ page }) => {
  const { state, editor } = await open(page, { orphaned: 0 })
  await type(page, editor, "just go")
  await expect.poll(() => state.calls.length).toBe(1)
  expect(state.calls[0]!.path).toBe(`/session/${session.id}/prompt_async`)
  await expect(page.getByRole("heading", { name: "Take over this session here?" })).toHaveCount(0)
})
