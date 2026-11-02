import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { DEFAULT_SOUNDS, SOUND_EVENTS, SOUND_IDS, clampVolume, isSoundID, soundLabel, stepVolume } from "./sounds"

const audio = path.join(import.meta.dir, "assets/audio")

describe("bundled sounds", () => {
  test("every ID has an .aac for the app and an .mp3 for the TUI", () => {
    for (const id of SOUND_IDS) {
      expect(existsSync(path.join(audio, `${id}.aac`))).toBe(true)
      expect(existsSync(path.join(audio, `${id}.mp3`))).toBe(true)
    }
  })

  test("every bundled file is offered", () => {
    const files = readdirSync(audio).map((file) => file.replace(/\.(aac|mp3)$/, ""))
    expect([...new Set(files)].toSorted()).toEqual([...SOUND_IDS].toSorted())
  })

  test("every event has a bundled default", () => {
    for (const event of SOUND_EVENTS) expect(isSoundID(DEFAULT_SOUNDS[event.id])).toBe(true)
  })

  test("labels name the family as it is", () => {
    expect(soundLabel("bip-bop-03")).toBe("Bip-bop 03")
    expect(soundLabel("alert-10")).toBe("Alert 10")
    expect(isSoundID("none")).toBe(false)
    expect(isSoundID("/tmp/alert-04.mp3")).toBe(false)
  })

  test("volume is clamped to 0–1 and stepped in tenths", () => {
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(4)).toBe(1)
    expect(clampVolume(Number.NaN)).toBe(0)
    expect(stepVolume(0.1 + 0.2)).toBe(0.3)
    expect(stepVolume(1.5)).toBe(1)
  })
})
