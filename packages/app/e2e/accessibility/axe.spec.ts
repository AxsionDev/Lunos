import AxeBuilder from "@axe-core/playwright"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

// XCOD-141: axe-core over the web app's main screens. The job fails on any serious or critical
// finding; moderate and minor findings are reported in the attached JSON but do not fail the run.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]
const BLOCKING = new Set(["serious", "critical"])
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

let errors: string[] = []

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe (${scheme})`, () => {
    test.beforeEach(async ({ page }) => {
      errors = []
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
      await mockOpenCodeServer(page, {
        protocol: "v1",
        sessions: fixture.sessions.map((session) => ({ ...session })),
        provider: fixture.provider,
        directory: fixture.directory,
        project: fixture.project,
        pageMessages,
        vcsDiff: [diff("src/app.ts"), diff("README.md")],
        fileList: (path) =>
          path
            ? []
            : [
                {
                  name: "README.md",
                  path: "README.md",
                  absolute: `${fixture.directory}/README.md`,
                  type: "file",
                  ignored: false,
                },
              ],
        fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
      })
      // The shared mock answers unknown paths with `{}`; the General settings tab needs a list here,
      // otherwise the app crashes behind the dialog and axe audits the error page instead.
      await page.route(/\/pty\/shells(?:\?.*)?$/, (route) =>
        route.fulfill({ json: [], headers: { "access-control-allow-origin": "*" } }),
      )
      page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
      await page.addInitScript((directory) => {
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: directory, expanded: true }] },
            lastProject: { local: directory },
          }),
        )
      }, fixture.directory)
    })

    test("home", async ({ page }, info) => {
      await page.goto("/")
      await expectAppVisible(
        page.locator('[data-component="home-session-row"]').filter({ hasText: fixture.expected.targetTitle }),
      )
      await audit(page, info, "home")
    })

    test("session", async ({ page }, info) => {
      await openSession(page)
      await expectAppVisible(page.getByRole("textbox", { name: "Prompt", exact: true }))
      await audit(page, info, "session")
    })

    test("session with review panel", async ({ page }, info) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          "opencode.global.dat:layout",
          JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }),
        )
      })
      await openSession(page)
      await expectAppVisible(page.locator("#review-panel"))
      await audit(page, info, "review")
    })

    test("review panel with context and file tabs open", async ({ page }, info) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          "opencode.global.dat:layout",
          JSON.stringify({ review: { diffStyle: "split", panelOpened: true } }),
        )
      })
      await openSession(page)
      const panel = page.locator("#review-panel")
      await expectAppVisible(panel)
      await page.getByRole("button", { name: "View context usage" }).click()
      await expect(panel.getByRole("tab", { name: "Context" })).toHaveAttribute("aria-selected", "true")
      await panel.getByRole("button", { name: "Open file" }).click()
      await panel.getByRole("button", { name: "README.md" }).click()
      await expect(panel.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true")
      await expect(panel.getByText("contents:README.md", { exact: true })).toBeVisible()
      await audit(page, info, "review-file-tabs")
      // Close buttons are hidden from assistive tech inside the tablist, so Delete closes the focused tab.
      await panel.getByRole("tab", { name: "README.md" }).press("Delete")
      await expect(panel.getByRole("tab", { name: "README.md" })).toHaveCount(0)
    })

    // XCOD-235: the Sessions window (all sessions on this machine), with a group and every state.
    test("sessions", async ({ page }, info) => {
      const now = Date.now()
      const row = (id: string, title: string, state: string, extra: object = {}) => ({
        id,
        kind: "session",
        title,
        directory: fixture.directory,
        project: { id: "prj_axe", name: "axe", worktree: fixture.directory },
        cost: 0.0123,
        created: now - 60_000,
        updated: now - 30_000,
        state,
        permissions: state === "waiting" ? 1 : 0,
        questions: 0,
        ...extra,
      })
      const overview = {
        groups: [{ id: "grp_axe", name: "Client A", color: "#3b82f6", collapsed: false, created: now, updated: now }],
        sessions: [
          row("ses_run", "Refactor parser", "running", { groupID: "grp_axe" }),
          row("ses_wait", "Deploy script", "waiting"),
          row("ses_other", "Long migration", "running", { elsewhere: true }),
          row("ses_stale", "Old experiment", "idle", { stale: true }),
          row("ses_done", "Fix typo", "finished"),
          row("ses_fail", "Flaky test", "failed"),
          row("external:abc", "Claude Code · axe", "running", { kind: "external", tool: "claude" }),
        ],
      }
      await page.route(/\/experimental\/session-overview(?:\?.*)?$/, (route) =>
        route.fulfill({ json: overview, headers: { "access-control-allow-origin": "*" } }),
      )
      await page.goto("/sessions")
      await expectAppVisible(page.getByText("Refactor parser", { exact: true }))
      await audit(page, info, "sessions")
      // XCOD-265: the bulk confirmation.
      await page.getByRole("button", { name: "Stop all", exact: true }).click()
      await expectAppVisible(page.getByRole("heading", { name: "Stop 4 sessions?" }))
      await audit(page, info, "sessions-stop-all")
    })

    for (const tab of ["General", "Shortcuts", "Servers", "Providers", "Models"]) {
      test(`settings: ${tab}`, async ({ page }, info) => {
        await openSession(page)
        await page.keyboard.press("Control+,")
        const dialog = page.locator(".settings-v2-dialog")
        await expectAppVisible(dialog)
        const trigger = dialog.getByRole("tab", { name: tab, exact: true })
        await trigger.click()
        await expect(trigger).toHaveAttribute("aria-selected", "true")
        await audit(page, info, `settings-${tab.toLowerCase()}`)
      })
    }
  })
}

async function openSession(page: Page) {
  await page.addInitScript(
    ({ server, sessionID }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { server, sessionID: fixture.targetID },
  )
  await page.goto(`/server/${base64Encode(server)}/session/${fixture.targetID}`)
  await expectSessionTitle(page, fixture.expected.targetTitle)
}

async function audit(page: Page, info: TestInfo, name: string) {
  const scheme = info.titlePath.some((part) => part === "axe (dark)") ? "dark" : "light"
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme)
  expect(errors).toEqual([])
  // Fade-ins (e.g. the prompt's model picker) would otherwise be measured mid-animation, at partial
  // opacity, and reported as contrast failures no user sees once the screen settles. Jump every
  // finite animation to its end state; infinite ones (spinners) are left alone.
  await page.evaluate(() => {
    for (const animation of document.getAnimations())
      if (animation.effect?.getTiming().iterations !== Infinity) animation.finish()
  })
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const summary = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
  }))
  await info.attach(`axe-${name}.json`, {
    body: JSON.stringify(result.violations, null, 2),
    contentType: "application/json",
  })
  for (const item of summary)
    console.log(
      `[axe] ${info.title} ${item.impact} ${item.id} x${item.nodes}: ${item.help} :: ${item.targets.join(" | ")}`,
    )
  if (process.env.AXE_VERBOSE)
    for (const violation of result.violations)
      for (const node of violation.nodes)
        console.log(
          `[axe-node] ${info.title} ${violation.id} ${node.target.join(" ")}\n  ${node.html.slice(0, 300)}\n  ${node.failureSummary?.replaceAll("\n", "\n  ")}`,
        )
  expect(summary.filter((item) => BLOCKING.has(item.impact ?? ""))).toEqual([])
}

function diff(file: string) {
  return {
    file,
    before: "before\n",
    after: "after\n",
    additions: 1,
    deletions: 1,
    status: "modified",
  }
}
