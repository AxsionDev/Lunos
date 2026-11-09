import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// XCOD-336 AC3: the mic button is desktop only. The web app transcribes nothing locally (its server
// may be on another machine), so its prompt has no mic button, even with voice on in the config.
// The desktop rule (`voice.enabled: false` removes it) is covered by voice-shown.test.ts.

const directory = "C:/OpenCode/PromptVoiceWeb"
const projectID = "proj_prompt_voice_web"
const sessionID = "ses_prompt_voice_web"

test("web: the prompt has no mic button, even with voice enabled in the config", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-voice-web",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-voice-web",
        projectID,
        directory,
        title: "Prompt voice web",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  // Registered after the mock, so it wins: a config that turns voice on.
  await page.route(/\/(global\/)?config(\?.*)?$/, (route) =>
    route.fulfill({ json: { voice: { enabled: true, model: "base" } } }),
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const prompt = page.locator('[data-component="prompt-input"]').first()
  await expectAppVisible(prompt)
  // The toolbar the mic button would sit in is drawn…
  await expect(page.locator('[data-action="prompt-submit"]').first()).toBeVisible()
  // …and has no mic button.
  await expect(page.locator('[data-action="prompt-voice"]')).toHaveCount(0)
})
