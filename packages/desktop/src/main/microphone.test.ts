import { describe, expect, test } from "bun:test"
import { microphoneOnly } from "./microphone"

describe("microphoneOnly", () => {
  test("allows a media request for the microphone alone", () => {
    expect(microphoneOnly("media", { mediaTypes: ["audio"] })).toBe(true)
    expect(microphoneOnly("media", { mediaType: "audio" })).toBe(true)
  })

  test("refuses the camera, screen capture, unknown media and other permissions", () => {
    expect(microphoneOnly("media", { mediaTypes: ["audio", "video"] })).toBe(false)
    expect(microphoneOnly("media", { mediaTypes: ["video"] })).toBe(false)
    expect(microphoneOnly("media", { mediaType: "video" })).toBe(false)
    expect(microphoneOnly("media", {})).toBe(false)
    expect(microphoneOnly("geolocation", { mediaTypes: ["audio"] })).toBe(false)
  })
})
