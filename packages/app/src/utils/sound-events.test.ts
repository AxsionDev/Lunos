import { describe, expect, test } from "bun:test"
import { askSound, doneSound, type SoundChoices } from "./sound-events"
import { SOUND_OPTIONS } from "./sound"
import { SOUND_IDS } from "@opencode-ai/ui/sounds"

// XCOD-311: the app's alerts pick sounds the way the TUI's do; the new ones are off by default.

const choices = (overrides: Partial<SoundChoices> = {}): SoundChoices => ({
  agent: { enabled: true, sound: "staplebops-01" },
  subagent: { enabled: false, sound: "yup-01" },
  permissions: { enabled: true, sound: "staplebops-02" },
  question: { enabled: false, sound: "bip-bop-03" },
  waiting: { enabled: false, sound: "staplebops-06" },
  ...overrides,
})

describe("app sound events", () => {
  test("defaults sound as before: approvals and a finished turn, nothing for the new events", () => {
    expect(askSound("permission", false, choices())).toBe("staplebops-02")
    expect(askSound("permission", true, choices())).toBe("staplebops-02")
    expect(askSound("question", false, choices())).toBeUndefined()
    expect(doneSound(false, choices())).toBe("staplebops-01")
    expect(doneSound(true, choices())).toBeUndefined()
  })

  test("a subagent's ask is Waiting for action once that sound is on; questions and subagents have their own", () => {
    const on = choices({
      subagent: { enabled: true, sound: "yup-02" },
      question: { enabled: true, sound: "alert-01" },
      waiting: { enabled: true, sound: "alert-09" },
    })
    expect(askSound("permission", true, on)).toBe("alert-09")
    expect(askSound("question", true, on)).toBe("alert-09")
    expect(askSound("question", false, on)).toBe("alert-01")
    expect(doneSound(true, on)).toBe("yup-02")
  })

  test("the app offers the same sound IDs as the TUI", () => {
    expect(SOUND_OPTIONS.map((option): string => option.id)).toEqual([...SOUND_IDS])
  })
})
