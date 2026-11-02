export * as VoiceModels from "./models"

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ConfigVoice } from "../config/voice"
import { Offline } from "../offline"

// XCOD-336: whisper.cpp's multilingual GGML models, from the whisper.cpp project's own Hugging Face
// repository (https://huggingface.co/ggerganov/whisper.cpp). Sizes and SHA-256 hashes are pinned
// here, copied from that repository's LFS metadata
// (https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main); the URL is pinned to a
// commit, so a changed file upstream is a failed download, never a different model.
//
// Runs under Bun (TUI) and Node (desktop main): node: APIs only, no Global, no Effect.

const REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1"
const BASE = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${REVISION}`

export type Spec = { file: string; size: number; sha256: string; url: string }

const spec = (file: string, size: number, sha256: string): Spec => ({ file, size, sha256, url: `${BASE}/${file}` })

export const MODELS: Record<ConfigVoice.Model, Spec> = {
  tiny: spec("ggml-tiny.bin", 77_691_713, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"),
  base: spec("ggml-base.bin", 147_951_465, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"),
  small: spec("ggml-small.bin", 487_601_967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"),
  medium: spec("ggml-medium.bin", 1_533_763_059, "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208"),
}

export const DEFAULT: ConfigVoice.Model = "base"

/**
 * Lunos's data directory, as Global.Path.data names it (xdg-basedir's rule), without importing
 * Global. Read at call time: the desktop app loads the login shell's environment after start.
 */
export function dataDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
}

/** Where models live: `<data>/voice/models`. The offline bundle's install guide copies them here. */
export function dir(data = dataDir()) {
  return path.join(data, "voice", "models")
}

export function file(model: ConfigVoice.Model, data = dataDir()) {
  return path.join(dir(data), MODELS[model].file)
}

const verified = new Set<string>()

/**
 * Whether the model is on disk with the pinned size and SHA-256. Hashed once per process: a model
 * copied in by hand (offline install) is checked before it is ever loaded.
 */
export async function installed(model: ConfigVoice.Model, data = dataDir()) {
  const target = file(model, data)
  if (verified.has(target)) return true
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat || stat.size !== MODELS[model].size) return false
  if ((await hashFile(target)) !== MODELS[model].sha256) return false
  verified.add(target)
  return true
}

export type Progress = { received: number; total: number }

/**
 * Download a model, after the user agreed to it. Written to a `.part` file, hashed while it
 * streams, and renamed into place only when size and SHA-256 match; anything else is deleted.
 */
export async function download(
  model: ConfigVoice.Model,
  options: {
    data?: string
    signal?: AbortSignal
    onProgress?: (progress: Progress) => void
    fetch?: typeof fetch
  } = {},
) {
  if (Offline.enabled()) throw new Offline.DisabledError("Downloading the voice model")
  const item = MODELS[model]
  const target = file(model, options.data)
  const part = `${target}.part`
  await fs.mkdir(path.dirname(target), { recursive: true })
  const response = await (options.fetch ?? fetch)(item.url, { signal: options.signal, redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`Voice model download failed: HTTP ${response.status}`)
  const hash = createHash("sha256")
  const out = await fs.open(part, "w")
  const received = await stream(response.body, async (chunk, total) => {
    hash.update(chunk)
    await out.write(chunk)
    options.onProgress?.({ received: total, total: item.size })
  })
    .finally(() => out.close())
    .catch(async (error) => {
      await fs.rm(part, { force: true })
      throw error
    })
  const digest = hash.digest("hex")
  if (received !== item.size || digest !== item.sha256) {
    await fs.rm(part, { force: true })
    throw new Error(`Voice model download didn't match its pinned SHA-256 (${item.file}); nothing was kept`)
  }
  await fs.rename(part, target)
  verified.add(target)
  return target
}

async function stream(body: ReadableStream<Uint8Array>, each: (chunk: Uint8Array, total: number) => Promise<void>) {
  const reader = body.getReader()
  let total = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return total
    total += chunk.value.byteLength
    await each(chunk.value, total)
  }
}

function hashFile(target: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(target)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")))
  })
}
