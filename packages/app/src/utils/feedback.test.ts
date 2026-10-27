import { describe, expect, test } from "bun:test"
import { feedbackInput, readScreenshot, SCREENSHOT_MAX_BYTES } from "./feedback"

// XCOD-318: the Feedback button never sends the session id unless the box is ticked.
describe("feedbackInput", () => {
  test("unticked: no session id, whatever the page knows", () => {
    const input = feedbackInput({ text: " Nice ", consent: false, sessionId: "ses_abc", desktop: false })
    expect(input).toEqual({ text: "Nice", source: "app", consent: false })
    expect(JSON.stringify(input)).not.toContain("ses_abc")
  })

  test("ticked: the session id; the desktop app says so", () => {
    expect(feedbackInput({ text: "x", consent: true, sessionId: "ses_abc", desktop: true })).toEqual({
      text: "x",
      source: "desktop",
      consent: true,
      sessionId: "ses_abc",
    })
  })
})

describe("readScreenshot", () => {
  test("PNG, JPEG or WebP up to 2 MB, as base64", async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" })
    expect(await readScreenshot(png)).toEqual({ type: "image/png", data: "iVBORw==" })
    expect(await readScreenshot(new File(["x"], "a.gif", { type: "image/gif" }))).toEqual({ error: "type" })
    const big = new File([new Uint8Array(SCREENSHOT_MAX_BYTES + 1)], "b.png", { type: "image/png" })
    expect(await readScreenshot(big)).toEqual({ error: "size" })
  })
})
