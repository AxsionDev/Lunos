export * as VoiceWhisper from "./whisper"

import { spawn as nodeSpawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ConfigVoice } from "../config/voice"
import { VoiceModels } from "./models"
import { VoiceWav } from "./wav"

// XCOD-336: transcription with whisper.cpp's `whisper-cli`, on this computer. The WAV goes to the
// process on stdin (`-f -`) and the text comes back on stdout (`-otxt -of -`): no audio file is
// ever written. whisper.cpp uses Metal or CUDA by itself when it was built with them, else the CPU.
// Nothing here logs the audio or the transcript.

/** The executable names whisper.cpp ships under (Homebrew and releases: whisper-cli). */
const NAMES = ["whisper-cli", "whisper-cpp"]

/**
 * whisper-cli: first one pre-installed in `<data>/voice/bin` (the offline bundle or an
 * administrator), then the PATH. There is deliberately no config key for this path.
 */
export function find(options: { data?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
  const bundled = path.join(options.data ?? VoiceModels.dataDir(), "voice", "bin")
  return NAMES.map((name) => which(name, { ...options, extra: [bundled] })).find(Boolean)
}

/** An executable on the PATH (after `extra` directories), with Windows' PATHEXT. */
export function which(
  name: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; extra?: string[] } = {},
) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""]
  const dirs = [...(options.extra ?? []), ...(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")]
  return dirs
    .filter(Boolean)
    .flatMap((dir) => exts.map((ext) => path.join(dir, name + ext.toLowerCase())))
    .find(executable)
}

export type Spawn = typeof nodeSpawn

export type Options = {
  binary: string
  model: string
  language?: string
  threads?: number
  signal?: AbortSignal
  spawn?: Spawn
}

/** Transcribe 16 kHz mono PCM held in memory. Resolves with the cleaned-up text (may be empty). */
export function transcribe(pcm: Int16Array, options: Options) {
  const child = (options.spawn ?? nodeSpawn)(options.binary, args(options), {
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.signal,
    windowsHide: true,
  })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
  // A whisper-cli that exits before reading everything (bad model, too old for `-f -`) closes the
  // pipe; the exit code below reports it.
  child.stdin?.on("error", () => {})
  child.stdin?.end(VoiceWav.encode(pcm))
  return new Promise<string>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) return resolve(clean(Buffer.concat(out).toString("utf8")))
      reject(new Error(failure(Buffer.concat(err).toString("utf8"), code)))
    })
  })
}

export function args(options: Pick<Options, "model" | "language" | "threads">) {
  return [
    "-m",
    options.model,
    "-f",
    "-",
    "-l",
    language(options.language),
    "-t",
    String(options.threads ?? Math.max(1, Math.min(8, os.availableParallelism() - 1))),
    "-nt",
    "-np",
    "-otxt",
    "-of",
    "-",
  ]
}

/** `auto`, or a whisper language code. Anything else falls back to auto rather than failing. */
export function language(value: string | undefined) {
  const code = value?.trim().toLowerCase()
  if (!code || !/^[a-z]{2,3}$/.test(code)) return "auto"
  return code
}

/** One line of text: whisper's segment breaks joined, its non-speech tags ([BLANK_AUDIO], ...) dropped. */
export function clean(text: string) {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** The model file to load, for the configured model name. */
export function model(name: ConfigVoice.Model | undefined, data?: string) {
  return VoiceModels.file(name ?? VoiceModels.DEFAULT, data)
}

function failure(stderr: string, code: number | null) {
  const line = stderr
    .split("\n")
    .map((item) => item.trim())
    .findLast((item) => /error|fail|unknown|invalid/i.test(item))
  return `whisper.cpp exited with ${code ?? "a signal"}${line ? `: ${line}` : ""}`
}

function executable(file: string) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
