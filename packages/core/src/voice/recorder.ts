export * as VoiceRecorder from "./recorder"

import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { VoiceWav } from "./wav"
import { VoiceWhisper } from "./whisper"

// XCOD-336: microphone capture for the TUI, which has no audio input of its own. A system recorder
// writes raw 16 kHz mono s16le to its stdout and the samples are kept in memory only; nothing is
// written to disk. The desktop app records in the renderer (Web Audio) instead.
//
// - macOS: ffmpeg with AVFoundation's default input. The microphone permission belongs to the
//   terminal app (System Settings > Privacy & Security > Microphone).
// - Windows: ffmpeg with DirectShow; the first audio capture device it lists.
// - Linux: PulseAudio's parecord (also PipeWire, through pipewire-pulse), else PipeWire's pw-record,
//   else ALSA's arecord, else ffmpeg's pulse input.

/** Longest recording kept: ten minutes is ~19 MB of samples. Longer ones stop on their own. */
export const MAX_SECONDS = 600

export type Command = { cmd: string; args: string[] }

const RAW = ["-ar", String(VoiceWav.RATE), "-ac", "1", "-f", "s16le", "-"]
const FFMPEG = ["-hide_banner", "-loglevel", "error", "-nostdin"]

/** The capture commands to try on this platform, in order. `device` is Windows' DirectShow name. */
export function commands(platform: NodeJS.Platform, device?: string): Command[] {
  if (platform === "darwin")
    return [{ cmd: "ffmpeg", args: [...FFMPEG, "-f", "avfoundation", "-i", ":default", ...RAW] }]
  if (platform === "win32")
    return device ? [{ cmd: "ffmpeg", args: [...FFMPEG, "-f", "dshow", "-i", `audio=${device}`, ...RAW] }] : []
  const rate = String(VoiceWav.RATE)
  return [
    { cmd: "parecord", args: ["--raw", `--rate=${rate}`, "--channels=1", "--format=s16le"] },
    { cmd: "pw-record", args: ["--raw", "--rate", rate, "--channels", "1", "--format", "s16", "-"] },
    { cmd: "arecord", args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", rate, "-c", "1"] },
    { cmd: "ffmpeg", args: [...FFMPEG, "-f", "pulse", "-i", "default", ...RAW] },
  ]
}

/** The first DirectShow audio device in `ffmpeg -list_devices` output. */
export function dshowDevice(listing: string) {
  return listing
    .split("\n")
    .map((line) => line.match(/"([^"]+)"\s*\(audio\)/)?.[1])
    .find((name): name is string => !!name)
}

/** Setup guidance when no recorder is installed, per platform. */
export function hint(platform: NodeJS.Platform) {
  if (platform === "darwin") return "Install ffmpeg for the microphone (brew install ffmpeg)"
  if (platform === "win32") return "Install ffmpeg for the microphone (winget install ffmpeg) and connect a microphone"
  return "Install PulseAudio or PipeWire tools (parecord or pw-record), alsa-utils (arecord) or ffmpeg"
}

/** Guidance when the recorder starts but the system refuses the microphone. */
export function permissionHint(platform: NodeJS.Platform) {
  if (platform === "darwin")
    return "Allow your terminal to use the microphone: System Settings > Privacy & Security > Microphone"
  if (platform === "win32")
    return "Allow desktop apps to use the microphone: Settings > Privacy & security > Microphone"
  return "Check that a microphone is connected and not muted (pavucontrol or wpctl status)"
}

export class Unavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VoiceRecorderUnavailable"
  }
}

export type Recording = {
  /** Stop and return every sample recorded, from memory. */
  stop(): Promise<Int16Array>
  /** Stop and drop the samples. */
  cancel(): void
}

export type Recorder = (options: { onLevel?: (level: number) => void }) => Recording

export type StartOptions = {
  onLevel?: (level: number) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: typeof nodeSpawn
}

/** Start recording with the first capture command installed. Throws Unavailable when none is. */
export function start(options: StartOptions = {}): Recording {
  const platform = options.platform ?? process.platform
  const command = resolve(platform, options.env)
  if (!command) throw new Unavailable(hint(platform))
  const child = (options.spawn ?? nodeSpawn)(command.cmd, command.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const chunks: Int16Array[] = []
  const state = { bytes: 0, odd: undefined as number | undefined, cancelled: false, stderr: "" }
  child.stdout?.on("data", (data: Buffer) => {
    if (state.cancelled || state.bytes >= MAX_SECONDS * VoiceWav.BYTES_PER_SECOND) return
    const bytes = state.odd === undefined ? data : Buffer.concat([Buffer.of(state.odd), data])
    state.odd = bytes.length % 2 ? bytes[bytes.length - 1] : undefined
    const even = bytes.subarray(0, bytes.length - (bytes.length % 2))
    // Copied into an aligned buffer: Node's pooled Buffers can start at an odd offset.
    const chunk = new Int16Array(new Uint8Array(even).buffer)
    state.bytes += even.length
    chunks.push(chunk)
    options.onLevel?.(VoiceWav.level(chunk))
  })
  child.stderr?.on("data", (data: Buffer) => {
    state.stderr = (state.stderr + data.toString("utf8")).slice(-2000)
  })
  const closed = new Promise<number | null>((done) => {
    child.on("close", (code) => done(code))
    child.on("error", () => done(-1))
  })
  return {
    async stop() {
      child.kill("SIGINT")
      const code = await closed
      if (!state.bytes && code !== 0)
        throw new Unavailable(`${permissionHint(platform)}${tail(state.stderr) ? ` (${tail(state.stderr)})` : ""}`)
      return VoiceWav.concat(chunks.splice(0))
    },
    cancel() {
      state.cancelled = true
      chunks.splice(0)
      child.kill("SIGINT")
    },
  }
}

function resolve(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env) {
  const installed = (cmd: string) => VoiceWhisper.which(cmd, { platform, env })
  if (platform !== "win32") return commands(platform).find((command) => installed(command.cmd))
  const ffmpeg = installed("ffmpeg")
  if (!ffmpeg) return
  // Listing devices takes a moment: once per process, not on every press.
  if (!windows.device) {
    const listing = spawnSync(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      encoding: "utf8",
      windowsHide: true,
    })
    windows.device = dshowDevice(`${listing.stdout ?? ""}\n${listing.stderr ?? ""}`)
  }
  if (!windows.device) throw new Unavailable("No microphone found. Connect one, then try again")
  return commands(platform, windows.device)[0]
}

const windows = { device: undefined as string | undefined }

function tail(stderr: string) {
  return stderr.trim().split("\n").at(-1)?.trim().slice(0, 200)
}
