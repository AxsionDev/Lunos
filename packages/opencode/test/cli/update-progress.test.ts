import { describe, expect, test } from "bun:test"
import { createUpdateProgress, updateProgressMode } from "../../src/cli/update-progress"
import { formatElapsed, upgradeProgressText } from "@opencode-ai/core/installation/version"

describe("lunos update progress (XCOD-247)", () => {
  test("animates only on a terminal that didn't ask for no motion", () => {
    expect(updateProgressMode(true, {})).toBe("animated")
    expect(updateProgressMode(true, { NO_COLOR: "1" })).toBe("static")
    expect(updateProgressMode(true, { TERM: "dumb" })).toBe("static")
    expect(updateProgressMode(false, {})).toBe("plain")
    expect(updateProgressMode(undefined, {})).toBe("plain")
  })

  test("plain output is one line per step, with no control characters, and a slow hint once", () => {
    let clock = 0
    const out: string[] = []
    const progress = createUpdateProgress({ mode: "plain", write: (text) => out.push(text), now: () => clock })
    progress.set("checking")
    progress.set("installing", "1.18.48")
    clock = 61_000
    progress.note("note")
    progress.note("again")
    progress.set("verifying", "1.18.48")
    progress.stop()
    expect(out.join("")).toBe(
      [
        "Checking for the latest version…",
        "Downloading and installing lunos-ai 1.18.48…",
        "note",
        "still working — package managers can be slow on first install",
        "again",
        "Verifying…",
        "",
      ].join("\n"),
    )
    expect(out.join("")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/)
  })

  test("static output says Updating… (step)", () => {
    const out: string[] = []
    const progress = createUpdateProgress({ mode: "static", write: (text) => out.push(text), now: () => 0 })
    progress.set("installing", "1.18.48")
    progress.stop()
    expect(out).toEqual(["Updating… (Downloading and installing lunos-ai 1.18.48…)\n"])
  })

  test("the animated line is rewritten in place and cleared at the end, leaving nothing behind", () => {
    const out: string[] = []
    const progress = createUpdateProgress({ mode: "animated", write: (text) => out.push(text), now: () => 12_000 })
    progress.set("installing", "1.18.48")
    progress.stop()
    expect(out[0]).toBe("\r\x1b[2K⠋ Downloading and installing lunos-ai 1.18.48… 0:00")
    expect(out.at(-1)).toBe("\r\x1b[2K")
  })

  test("elapsed time and the slow hint", () => {
    expect(formatElapsed(12_400)).toBe("0:12")
    expect(formatElapsed(65_000)).toBe("1:05")
    expect(upgradeProgressText("installing", "1.2.3", 59_000, 59_000)).toBe(
      "Downloading and installing lunos-ai 1.2.3… 0:59",
    )
    expect(upgradeProgressText("installing", "1.2.3", 60_000, 72_000)).toBe(
      "Downloading and installing lunos-ai 1.2.3… 1:12 — still working, package managers can be slow on first install",
    )
  })
})
