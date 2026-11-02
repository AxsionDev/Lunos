import { expect, test } from "bun:test"
import { findSessionUrl } from "../../src/cli/cmd/pr"

// XCOD-266: `lunos pr` imports the session the GitHub action linked, from wherever it was shared.
test("finds the session link the GitHub action writes", () => {
  const body =
    "Fixes the bug.\n\n[Lunos session](https://console.example.com/share/abc123)&nbsp;&nbsp;|&nbsp;&nbsp;[Run](https://github.com/o/r/actions/runs/1)"
  expect(findSessionUrl(body)).toBe("https://console.example.com/share/abc123")
})

test("finds an old upstream link, so it can say why it isn't imported", () => {
  expect(findSessionUrl("Session: https://opncd.ai/s/Jsj3hNIW")).toBe("https://opncd.ai/s/Jsj3hNIW")
})

test("finds nothing in a PR without a session link", () => {
  expect(findSessionUrl("Just a description with https://example.com/share/abc in it")).toBeUndefined()
})
