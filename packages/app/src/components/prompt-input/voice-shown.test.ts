import { describe, expect, test } from "bun:test"
import { voiceButtonShown } from "./voice-shown"

// XCOD-336 AC3: the mic button is on the desktop prompt only, and `voice.enabled: false` removes it.
describe("voiceButtonShown", () => {
  test("desktop: shown unless the config turns voice off", () => {
    expect(voiceButtonShown({ local: true, config: undefined })).toBe(true)
    expect(voiceButtonShown({ local: true, config: {} })).toBe(true)
    expect(voiceButtonShown({ local: true, config: { enabled: true } })).toBe(true)
    expect(voiceButtonShown({ local: true, config: { enabled: false } })).toBe(false)
  })

  test("web (no local transcription): never shown, whatever the config says", () => {
    expect(voiceButtonShown({ local: false, config: undefined })).toBe(false)
    expect(voiceButtonShown({ local: false, config: { enabled: true } })).toBe(false)
  })
})
