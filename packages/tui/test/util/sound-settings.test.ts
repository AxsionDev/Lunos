import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSoundPreview, PREVIEW_DELAY_MS } from "../../src/util/sound-preview"
import { checkSoundFile, soundFilePath } from "../../src/util/sound-file"
import * as SoundSettings from "../../src/util/sound-settings"
import * as Sections from "../../src/util/settings-sections"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// XCOD-311: Settings › Notifications & sounds. The player is a fake throughout: nothing is heard.

/** Manual timers, so the debounce is stepped rather than waited on. */
function fakeTimers() {
  let next = 0
  const pending = new Map<number, () => void>()
  return {
    set: ((fn: () => void) => {
      const id = ++next
      pending.set(id, fn)
      return id
    }) as unknown as typeof setTimeout,
    clear: ((id: number) => void pending.delete(id)) as unknown as typeof clearTimeout,
    flush() {
      const due = [...pending.values()]
      pending.clear()
      for (const fn of due) fn()
    },
    get size() {
      return pending.size
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("sound preview", () => {
  test("moving quickly through the list plays only the last highlight, once", async () => {
    const timers = fakeTimers()
    const played: string[] = []
    const preview = createSoundPreview(async (sound) => {
      played.push(sound)
      return () => played.push(`stop ${sound}`)
    }, timers)

    preview.play("alert-01")
    preview.play("alert-02")
    preview.play("alert-03")
    expect(timers.size).toBe(1)
    timers.flush()
    await tick()
    expect(played).toEqual(["alert-03"])

    // The next highlight stops the one playing before its own starts: sounds never stack.
    preview.play("alert-04")
    expect(played).toEqual(["alert-03", "stop alert-03"])
    timers.flush()
    await tick()
    expect(played).toEqual(["alert-03", "stop alert-03", "alert-04"])
  })

  test("a sound that resolves after the highlight moved on is stopped at once", async () => {
    const timers = fakeTimers()
    const stopped: string[] = []
    let resolve: ((stop: () => void) => void) | undefined
    const preview = createSoundPreview(
      (sound) =>
        new Promise((done) => {
          resolve = () => done(() => stopped.push(sound))
        }),
      timers,
    )
    preview.play("yup-01")
    timers.flush()
    preview.play(undefined)
    resolve?.(() => {})
    await tick()
    expect(stopped).toEqual(["yup-01"])
  })

  test("None stops without playing, and the delay matches the desktop's", () => {
    const timers = fakeTimers()
    const preview = createSoundPreview(async () => undefined, timers)
    preview.play(undefined)
    expect(timers.size).toBe(0)
    expect(PREVIEW_DELAY_MS).toBe(100)
  })
})

describe("custom sound file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lunos-sound-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, body = "ID3") => {
    const file = path.join(dir, name)
    writeFileSync(file, body)
    return file
  }

  test("a readable .mp3, .aac or .wav is saved as its absolute path", async () => {
    for (const name of ["chime.mp3", "chime.aac", "CHIME.WAV"]) {
      const file = write(name)
      expect(await checkSoundFile(name, { cwd: dir })).toEqual({ ok: true, file })
    }
    expect(soundFilePath("~/a.mp3", "/x", "/home/me")).toBe("/home/me/a.mp3")
    expect(soundFilePath("file:///tmp/a.mp3")).toBe("/tmp/a.mp3")
  })

  test("a missing, empty, wrong-type or unreadable file is refused with a clear message", async () => {
    expect(await checkSoundFile(path.join(dir, "missing.mp3"))).toEqual({
      ok: false,
      error: `No file at ${path.join(dir, "missing.mp3")}`,
    })
    expect(await checkSoundFile("  ")).toEqual({ ok: false, error: "Type the path to a sound file" })
    expect(await checkSoundFile(write("notes.txt"))).toEqual({
      ok: false,
      error: "notes.txt isn't an .mp3, .aac or .wav file",
    })
    expect(await checkSoundFile(write("empty.mp3", ""))).toMatchObject({
      ok: false,
      error: expect.stringContaining("is empty"),
    })
    mkdirSync(path.join(dir, "folder.mp3"))
    expect(await checkSoundFile(path.join(dir, "folder.mp3"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("is a folder"),
    })
    if (process.getuid?.() !== 0) {
      const locked = write("locked.mp3")
      chmodSync(locked, 0o000)
      expect(await checkSoundFile(locked)).toEqual({ ok: false, error: `Lunos can't read ${locked}` })
      chmodSync(locked, 0o600)
    }
  })

  test("a file that can't be decoded is refused; with no audio to try, the file check decides", async () => {
    const file = write("garbage.mp3", "not audio")
    expect(await checkSoundFile(file, { decode: async () => false })).toEqual({
      ok: false,
      error: "garbage.mp3 couldn't be played as a sound",
    })
    expect(await checkSoundFile(file, { decode: async () => undefined })).toEqual({ ok: true, file })
  })
})

describe("notifications & sounds section", () => {
  test("rows are listed in the section's order, without the attention object itself", () => {
    const keys = [
      "tui.attention",
      "tui.attention.sounds.default",
      "tui.attention.volume",
      "tui.attention.sounds.done",
      "tui.attention.enabled",
      "tui.attention.sounds.permission",
    ]
    expect(SoundSettings.orderRows(keys.map((key) => ({ key }))).map((row) => row.key)).toEqual([
      "tui.attention.enabled",
      "tui.attention.volume",
      "tui.attention.sounds.done",
      "tui.attention.sounds.permission",
      "tui.attention.sounds.default",
    ])
  })

  test("rows show words: a percentage, the sound's name, a custom file, the pack default", () => {
    const show = (key: string, value: unknown, source: "default" | "user" = "user") =>
      SoundSettings.display({ key, value, display: String(value), source }, { packSound: () => "bip-bop-01" })
    expect(show("tui.attention.volume", 0.6)).toBe("60%")
    expect(show("tui.attention.sounds.permission", "alert-04")).toBe("Alert 04")
    expect(show("tui.attention.sounds.error", "none")).toBe("None")
    expect(show("tui.attention.sounds.done", "/home/me/chime.wav")).toBe("Custom: chime.wav")
    expect(show("tui.attention.sounds.done", undefined, "default")).toBe("Bip-bop 01 (default)")
    expect(show("tui.attention.notify_when", "blurred")).toBe("in the background")
  })

  test("a sound select offers None, every bundled sound by family, a custom file and a reset", () => {
    const choices = SoundSettings.soundChoices({ current: "alert-04", packDefault: "staplebops-06" })
    expect(choices[0]).toMatchObject({ title: "None", value: "none" })
    expect(choices.filter((item) => item.category === "Bip-bop")).toHaveLength(10)
    expect(choices.find((item) => item.value === "staplebops-06")?.footer).toBe("pack default")
    expect(choices.slice(-2).map((item) => item.value)).toEqual([SoundSettings.CUSTOM_FILE, SoundSettings.PACK_DEFAULT])
    expect(choices).toHaveLength(1 + 45 + 2)
  })

  test("a saved value applies to the running config; a removed one goes back to the default", () => {
    const { attention } = createTuiResolvedConfig()
    SoundSettings.apply(attention, "tui.attention.sounds.permission", "alert-04")
    SoundSettings.apply(attention, "tui.attention.volume", 0.1 + 0.2)
    SoundSettings.apply(attention, "tui.attention.notify_when", "always")
    expect(attention).toMatchObject({ sounds: { permission: "alert-04" }, volume: 0.3, notify_when: "always" })
    SoundSettings.apply(attention, "tui.attention.sounds.permission", undefined)
    SoundSettings.apply(attention, "tui.attention.volume", undefined)
    expect(attention.sounds).toEqual({})
    expect(attention.volume).toBe(0.4)
    // Volume is clamped whatever was saved.
    SoundSettings.apply(attention, "tui.attention.volume", 3)
    expect(attention.volume).toBe(1)
  })

  test("deep links, and the home's summary", () => {
    expect(Sections.target("sounds")).toEqual({ category: "Notifications & sounds", sub: "Sounds" })
    expect(Sections.target("notifications")).toEqual({ category: "Notifications & sounds", sub: "Notifications" })
    expect(Sections.target("sound")).toEqual({ category: "Notifications & sounds" })
    const row = (key: string, display: string, source: "default" | "user" = "user") => ({
      key: `tui.attention.${key}`,
      display,
      source,
    })
    expect(
      Sections.summary("Notifications & sounds", [
        row("enabled", "true"),
        row("sound", "true", "default"),
        row("volume", "0.6"),
        row("sounds.permission", "alert-04"),
        row("sounds.done", "yup-02"),
      ]),
    ).toBe("Sounds on · 60% · 2 custom")
    expect(Sections.summary("Notifications & sounds", [row("enabled", "false", "default")])).toBe("alerts off")
    expect(Sections.summary("Notifications & sounds", [row("enabled", "true"), row("sound", "false")])).toBe(
      "Sounds off",
    )
  })
})
