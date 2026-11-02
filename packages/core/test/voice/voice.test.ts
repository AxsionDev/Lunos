import fs from "fs/promises"
import path from "path"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { afterEach, describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { Offline } from "@opencode-ai/core/offline"
import { VoiceDictation } from "@opencode-ai/core/voice/dictation"
import { VoiceModels } from "@opencode-ai/core/voice/models"
import { VoicePtt } from "@opencode-ai/core/voice/ptt"
import { VoiceRecorder } from "@opencode-ai/core/voice/recorder"
import { VoiceWav } from "@opencode-ai/core/voice/wav"
import { VoiceWhisper } from "@opencode-ai/core/voice/whisper"
import { tmpdir } from "../fixture/tmpdir"

const previous = process.env[Offline.ENV]
afterEach(() => {
  if (previous === undefined) delete process.env[Offline.ENV]
  else process.env[Offline.ENV] = previous
})

const tone = (seconds: number) =>
  Int16Array.from({ length: seconds * VoiceWav.RATE }, (_, i) => Math.round(Math.sin(i / 8) * 8000))

/** Every file under `dir`, for "nothing was written" checks. */
async function files(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
}

/**
 * A stand-in whisper-cli: refuses to run unless audio comes on stdin (`-f -`) and text goes to
 * stdout (`-of -`), checks the WAV header, and answers with whisper's own line format.
 */
async function fakeWhisper(dir: string) {
  const file = path.join(dir, "whisper-cli")
  await Bun.write(
    file,
    `#!/bin/sh
case "$*" in *"-f - "*) ;; *) echo "error: audio not on stdin" >&2; exit 2;; esac
case "$*" in *"-of -"*) ;; *) echo "error: text not on stdout" >&2; exit 2;; esac
head=$(head -c 4)
[ "$head" = "RIFF" ] || { echo "error: not a wav" >&2; exit 3; }
cat > /dev/null
printf ' Please add tests\\n for the parser. [BLANK_AUDIO]\\n'
`,
  )
  await fs.chmod(file, 0o755)
  return file
}

describe("VoiceWav", () => {
  test("wraps PCM in a 16 kHz mono 16-bit WAV header, in memory", () => {
    const wav = VoiceWav.encode(tone(1))
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF")
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(40, true)).toBe(32_000)
    expect(wav.length).toBe(44 + 32_000)
  })

  test("level is 0 for silence and grows with loudness", () => {
    expect(VoiceWav.level(new Int16Array(160))).toBe(0)
    const quiet = VoiceWav.level(Int16Array.from({ length: 160 }, () => 300))
    const loud = VoiceWav.level(Int16Array.from({ length: 160 }, () => 12_000))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
    expect(loud).toBeLessThanOrEqual(1)
  })

  test("fromFloat clamps Web Audio samples", () => {
    expect([...VoiceWav.fromFloat(Float32Array.from([0, 1, -1, 2]))]).toEqual([0, 32767, -32767, 32767])
  })
})

describe("VoiceWhisper", () => {
  test("audio goes in on stdin and text comes out on stdout; never a file", () => {
    const args = VoiceWhisper.args({ model: "/m/ggml-base.bin", language: undefined, threads: 4 })
    expect(args.join(" ")).toContain("-f -")
    expect(args.join(" ")).toContain("-otxt -of -")
    expect(args.join(" ")).toContain("-l auto")
  })

  test("language is a whisper code or auto", () => {
    expect(VoiceWhisper.language(undefined)).toBe("auto")
    expect(VoiceWhisper.language("BG")).toBe("bg")
    expect(VoiceWhisper.language("auto")).toBe("auto")
    expect(VoiceWhisper.language("--model=/evil")).toBe("auto")
  })

  test("clean joins segments and drops non-speech tags", () => {
    expect(VoiceWhisper.clean(" Hello\n world. [BLANK_AUDIO]\n")).toBe("Hello world.")
    expect(VoiceWhisper.clean("[BLANK_AUDIO]")).toBe("")
  })

  test("find prefers the pre-installed whisper-cli in <data>/voice/bin, then the PATH", async () => {
    await using data = await tmpdir()
    await using bin = await tmpdir()
    const onPath = await fakeWhisper(bin.path)
    expect(VoiceWhisper.find({ data: data.path, env: { PATH: bin.path }, platform: "linux" })).toBe(onPath)
    await fs.mkdir(path.join(data.path, "voice", "bin"), { recursive: true })
    const bundled = await fakeWhisper(path.join(data.path, "voice", "bin"))
    expect(VoiceWhisper.find({ data: data.path, env: { PATH: bin.path }, platform: "linux" })).toBe(bundled)
    expect(VoiceWhisper.find({ data: bin.path + "-none", env: { PATH: "" }, platform: "linux" })).toBeUndefined()
  })

  test.skipIf(process.platform === "win32")("transcribes from memory without writing audio to disk", async () => {
    await using bin = await tmpdir()
    const binary = await fakeWhisper(bin.path)
    const before = await files(bin.path)
    const text = await VoiceWhisper.transcribe(tone(2), { binary, model: path.join(bin.path, "ggml-base.bin") })
    expect(text).toBe("Please add tests for the parser.")
    expect(await files(bin.path)).toEqual(before)
  })

  test.skipIf(process.platform === "win32")("a failing whisper-cli is an error naming its message", async () => {
    await using bin = await tmpdir()
    const binary = path.join(bin.path, "whisper-cli")
    await Bun.write(binary, "#!/bin/sh\ncat >/dev/null\necho 'error: failed to load model' >&2\nexit 1\n")
    await fs.chmod(binary, 0o755)
    await expect(VoiceWhisper.transcribe(tone(1), { binary, model: "x" })).rejects.toThrow("failed to load model")
  })
})

describe("VoiceModels", () => {
  test("pins the four multilingual models with sizes and SHA-256 at one upstream revision", () => {
    expect(Object.keys(VoiceModels.MODELS)).toEqual(["tiny", "base", "small", "medium"])
    expect(VoiceModels.DEFAULT).toBe("base")
    for (const spec of Object.values(VoiceModels.MODELS)) {
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(spec.url).toMatch(/^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/ggml-/)
    }
  })

  test("the data directory is Lunos's own (Global.Path.data), without importing Global", () => {
    expect(VoiceModels.dataDir()).toBe(Global.Path.data)
  })

  test("models live in <data>/voice/models", () => {
    expect(VoiceModels.file("base", "/d")).toBe(path.join("/d", "voice", "models", "ggml-base.bin"))
  })

  test("a missing or wrong-sized model is not installed", async () => {
    await using data = await tmpdir()
    expect(await VoiceModels.installed("tiny", data.path)).toBe(false)
    await fs.mkdir(VoiceModels.dir(data.path), { recursive: true })
    await Bun.write(VoiceModels.file("tiny", data.path), "not a model")
    expect(await VoiceModels.installed("tiny", data.path)).toBe(false)
  })

  test("a download that doesn't match the pinned SHA-256 keeps nothing", async () => {
    await using data = await tmpdir()
    const progress: number[] = []
    const fake = (async () => new Response("tampered model bytes")) as unknown as typeof fetch
    await expect(
      VoiceModels.download("tiny", { data: data.path, fetch: fake, onProgress: (p) => progress.push(p.received) }),
    ).rejects.toThrow("SHA-256")
    expect(progress.at(-1)).toBe("tampered model bytes".length)
    expect(await files(data.path)).toEqual([])
  })

  test("offline mode refuses the download before any request", async () => {
    await using data = await tmpdir()
    process.env[Offline.ENV] = "1"
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return new Response("")
    }) as unknown as typeof fetch
    await expect(VoiceModels.download("base", { data: data.path, fetch: fake })).rejects.toThrow("LUNOS_OFFLINE")
    expect(calls).toEqual([])
  })

  test("the download is listed with the other outbound calls", () => {
    expect(Offline.CALLS.find((call) => call.id === "voice-model")?.offline).toBe("blocked")
  })
})

describe("VoiceRecorder", () => {
  test("capture commands write raw 16 kHz mono PCM to stdout on every platform", () => {
    const mac = VoiceRecorder.commands("darwin")
    expect(mac[0]?.cmd).toBe("ffmpeg")
    expect(mac[0]?.args).toEqual(expect.arrayContaining(["avfoundation", ":default", "16000", "s16le", "-"]))
    expect(VoiceRecorder.commands("win32")).toEqual([])
    expect(VoiceRecorder.commands("win32", "Microphone (Realtek)")[0]?.args).toContain("audio=Microphone (Realtek)")
    expect(VoiceRecorder.commands("linux").map((c) => c.cmd)).toEqual(["parecord", "pw-record", "arecord", "ffmpeg"])
    // No capture command is ever given a file to write.
    for (const platform of ["darwin", "linux"] as const)
      for (const command of VoiceRecorder.commands(platform))
        expect(command.args.some((arg) => /\.(wav|raw|pcm)$/.test(arg))).toBe(false)
  })

  test("dshowDevice picks the first audio device ffmpeg lists", () => {
    const listing = [
      '[dshow @ 000] "Integrated Camera" (video)',
      '[dshow @ 000]   Alternative name "@device_pnp_..."',
      '[dshow @ 000] "Microphone Array (Realtek(R) Audio)" (audio)',
      '[dshow @ 000] "Headset (USB)" (audio)',
    ].join("\n")
    expect(VoiceRecorder.dshowDevice(listing)).toBe("Microphone Array (Realtek(R) Audio)")
    expect(VoiceRecorder.dshowDevice("nothing")).toBeUndefined()
  })

  test("without a recorder installed, start explains what to install", () => {
    expect(() => VoiceRecorder.start({ platform: "darwin", env: { PATH: "" } })).toThrow("brew install ffmpeg")
  })

  test("keeps samples in memory, across odd chunk boundaries, and reports levels", async () => {
    await using bin = await tmpdir()
    const ffmpeg = path.join(bin.path, "ffmpeg")
    await Bun.write(ffmpeg, "#!/bin/sh\n")
    await fs.chmod(ffmpeg, 0o755)
    const emitter = new EventEmitter()
    const killed: string[] = []
    const child = Object.assign(emitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal: string) {
        killed.push(signal)
        setTimeout(() => emitter.emit("close", 0), 5)
        return true
      },
    })
    const spawned: string[][] = []
    const spawn = ((cmd: string, args: string[]) => {
      spawned.push([cmd, ...args])
      return child
    }) as unknown as typeof import("child_process").spawn
    const levels: number[] = []
    const recording = VoiceRecorder.start({
      platform: "darwin",
      env: { PATH: bin.path },
      spawn,
      onLevel: (level) => levels.push(level),
    })
    const bytes = new Uint8Array(new Int16Array([1000, -1000, 2000]).buffer)
    child.stdout.emit("data", Buffer.from(bytes.subarray(0, 3)))
    child.stdout.emit("data", Buffer.from(bytes.subarray(3)))
    const pcm = await recording.stop()
    expect([...pcm]).toEqual([1000, -1000, 2000])
    expect(levels.length).toBe(2)
    expect(killed).toEqual(["SIGINT"])
    expect(spawned[0]?.[0]).toBe("ffmpeg")
  })
})

describe("VoicePtt", () => {
  test("a held key (auto-repeating presses) records until the repeats stop", () => {
    const ptt = VoicePtt.create()
    expect(ptt.press(0)).toBe("start")
    expect(ptt.press(500)).toBeUndefined()
    expect(ptt.press(530)).toBeUndefined()
    expect(ptt.press(560)).toBeUndefined()
    expect(ptt.tick(700)).toBeUndefined()
    expect(ptt.tick(900)).toBe("stop")
    expect(ptt.mode).toBe("idle")
  })

  test("a single tap toggles: record until the next press", () => {
    const ptt = VoicePtt.create()
    expect(ptt.press(0)).toBe("start")
    expect(ptt.tick(800)).toBeUndefined()
    expect(ptt.mode).toBe("toggled")
    expect(ptt.tick(20_000)).toBeUndefined()
    expect(ptt.press(20_000)).toBe("stop")
  })

  test("auto-repeats after a stop don't start a new recording", () => {
    const ptt = VoicePtt.create()
    ptt.press(0)
    ptt.tick(800)
    expect(ptt.press(5000)).toBe("stop")
    expect(ptt.press(5400)).toBeUndefined()
    expect(ptt.press(5430)).toBeUndefined()
    expect(ptt.press(6000)).toBe("start")
  })

  test("terminals that report releases: hold-and-release stops, a quick tap toggles", () => {
    const held = VoicePtt.create()
    held.press(0)
    held.press(40, true)
    expect(held.release(3000)).toBe("stop")
    const tap = VoicePtt.create()
    tap.press(0)
    expect(tap.release(120)).toBeUndefined()
    expect(tap.mode).toBe("toggled")
    expect(tap.press(4000)).toBe("stop")
  })
})

describe("VoicePtt with releases (the desktop mic button)", () => {
  test("a long press records until it is released, however long", () => {
    const ptt = VoicePtt.create({ releases: true })
    expect(ptt.press(0)).toBe("start")
    expect(ptt.tick(5000)).toBeUndefined()
    expect(ptt.mode).toBe("pending")
    expect(ptt.release(9000)).toBe("stop")
  })

  test("a click starts, the next click stops", () => {
    const ptt = VoicePtt.create({ releases: true })
    expect(ptt.press(0)).toBe("start")
    expect(ptt.release(150)).toBeUndefined()
    expect(ptt.tick(5000)).toBeUndefined()
    expect(ptt.press(8000)).toBe("stop")
    expect(ptt.release(8100)).toBeUndefined()
  })
})

describe("VoiceDictation", () => {
  // The recorder and the transcriber are stand-ins: this is the flow from key presses to text.
  const setup = (input: { transcribe?: (pcm: Int16Array) => Promise<string>; samples?: Int16Array } = {}) => {
    const clock = { now: 0 }
    const events = { texts: [] as string[], errors: [] as string[], phases: [] as string[], cancelled: 0 }
    const transcribed: Int16Array[] = []
    const dictation = VoiceDictation.create({
      now: () => clock.now,
      recorder: (options) => {
        options.onLevel?.(0.5)
        return {
          stop: async () => input.samples ?? tone(2),
          cancel: () => {
            events.cancelled++
          },
        }
      },
      transcribe:
        input.transcribe ??
        (async (pcm) => {
          transcribed.push(pcm)
          return "Refactor the parser"
        }),
      onStatus: (status) => events.phases.push(status.phase),
      onText: (text) => events.texts.push(text),
      onError: (error) => events.errors.push(error.message),
    })
    return { clock, events, dictation, transcribed }
  }

  test("hold, speak, release: the transcript is handed over, not sent", async () => {
    const { clock, events, dictation, transcribed } = setup()
    dictation.press()
    clock.now = 500
    dictation.press()
    clock.now = 2000
    dictation.press()
    clock.now = 2400
    dictation.tick()
    await Bun.sleep(0)
    expect(events.texts).toEqual(["Refactor the parser"])
    expect(transcribed[0]?.length).toBe(2 * VoiceWav.RATE)
    expect(events.phases).toContain("transcribing")
    expect(dictation.status.phase).toBe("idle")
  })

  test("Esc while recording drops the audio and transcribes nothing", async () => {
    const { clock, events, dictation, transcribed } = setup()
    dictation.press()
    clock.now = 3000
    dictation.cancel()
    await Bun.sleep(0)
    expect(events.cancelled).toBe(1)
    expect(transcribed).toEqual([])
    expect(events.texts).toEqual([])
    expect(dictation.status.phase).toBe("idle")
  })

  test("an accidental blip shorter than the minimum is dropped", async () => {
    const { clock, events, dictation, transcribed } = setup()
    dictation.press()
    clock.now = 100
    dictation.release()
    clock.now = 150
    dictation.press()
    await Bun.sleep(0)
    expect(transcribed).toEqual([])
    expect(events.cancelled).toBe(1)
  })

  test("a recorder that can't start is reported, and the key works again", () => {
    const errors: string[] = []
    const dictation = VoiceDictation.create({
      recorder: () => {
        throw new VoiceRecorder.Unavailable("Install ffmpeg")
      },
      transcribe: async () => "",
      onStatus: () => {},
      onText: () => {},
      onError: (error) => errors.push(error.message),
    })
    dictation.press()
    expect(errors).toEqual(["Install ffmpeg"])
    expect(dictation.status.phase).toBe("idle")
  })

  test("no network request is made while recording or transcribing", async () => {
    const original = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(String(url))
      throw new Error("network used")
    }) as unknown as typeof fetch
    try {
      await using bin = await tmpdir()
      const binary = await fakeWhisper(bin.path)
      const { clock, events, dictation } = setup({
        transcribe: (pcm) => VoiceWhisper.transcribe(pcm, { binary, model: path.join(bin.path, "m.bin") }),
      })
      dictation.press()
      clock.now = 800
      dictation.tick()
      clock.now = 5000
      dictation.press()
      await Bun.sleep(200)
      expect(events.errors).toEqual([])
      expect(events.texts).toEqual(["Please add tests for the parser."])
      expect(requests).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })
})
