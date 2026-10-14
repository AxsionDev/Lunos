export * as CloudSyncRedact from "./sync-redact"

import path from "path"
import { Audit } from "@opencode-ai/core/audit"

/**
 * Session sync's two content layers (lunos-web spec 2026-10-13 §3, C7), in order:
 *
 * 1. Path rule (the guarantee): a tool call, attachment or diff that touches a never-upload file has
 *    its content replaced with `[not synced: <path>]`. Search output keeps its other lines.
 * 2. Scanner (best effort): the audit writer's credential patterns over every string.
 */
export const NEVER = [".env", ".env.*", "auth.json", "*.pem", "*.key", "id_rsa", "id_rsa.*"] as const

const placeholder = (p: string) => `[not synced: ${p}]`

export function matcher(directory: string, exclude: readonly string[]) {
  const base = NEVER.map((g) => new Bun.Glob(g))
  const extra = exclude.map((g) => new Bun.Glob(g))
  return (p: string) => {
    p = p.replaceAll("\\", "/")
    const name = path.posix.basename(p)
    if (base.some((g) => g.match(name))) return true
    const rel = path.isAbsolute(p) ? path.relative(directory, p) : p
    return extra.some((g) => g.match(rel) || g.match(name))
  }
}

const PATH_KEYS = ["filePath", "file_path", "path", "file"] as const
// Header syntax of packages/opencode/src/patch/index.ts (`*** Add|Update|Delete File: <path>`, `*** Move to: <path>`).
const PATCH_FILE = /^\s*\*\*\* (?:Add|Update|Delete) File:(.+)$/gm
const MOVE_TO = /^\s*\*\*\* Move to:(.+)$/gm

/** Every file a tool call's input names. */
function inputPaths(input: Record<string, unknown> | undefined, raw?: unknown) {
  // A tool call still streaming has its arguments only as `raw` JSON.
  if (!input || (Object.keys(input).length === 0 && typeof raw === "string")) {
    try {
      input = JSON.parse(raw as string)
    } catch {
      return []
    }
    if (!input || typeof input !== "object") return []
  }
  const out = PATH_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === "string")
  const patch = input.patchText
  if (typeof patch === "string") for (const re of [PATCH_FILE, MOVE_TO]) for (const m of patch.matchAll(re)) out.push(m[1]!.trim())
  return out
}

/**
 * Search output (grep.ts): `Found N matches`, then per file a `<path>:` header followed by indented
 * `  Line N: <text>` lines, groups separated by a blank line. A header naming a secret file, and the
 * match lines under it, become one placeholder line.
 */
function filterLines(output: string, isSecret: (p: string) => boolean) {
  const lines = output.split("\n")
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line === "") skipping = false
    const header = !/^\s/.test(line) && line.endsWith(":")
    if (header) {
      const candidate = line.slice(0, -1)
      skipping = isSecret(candidate)
      kept.push(skipping ? placeholder(candidate) : line)
      continue
    }
    if (!skipping) kept.push(line)
  }
  return kept.join("\n")
}

const SEARCH_TOOLS = new Set(["grep"])

function toolPart(part: any, isSecret: (p: string) => boolean) {
  const state = part.state
  if (!state || typeof state !== "object") return part
  const hit = inputPaths(state.input, state.raw).find(isSecret)
  if (hit) {
    const blank = placeholder(hit)
    const input: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(state.input ?? {})) input[k] = typeof v === "string" && !PATH_KEYS.includes(k as any) ? blank : v
    return {
      ...part,
      state: {
        ...state,
        input,
        ...("title" in state ? { title: blank } : {}),
        ...("output" in state ? { output: blank } : {}),
        ...("error" in state ? { error: blank } : {}),
        ...("metadata" in state ? { metadata: {} } : {}),
        ...("attachments" in state ? { attachments: [] } : {}),
        ...("raw" in state ? { raw: blank } : {}),
      },
    }
  }
  if (SEARCH_TOOLS.has(part.tool) && typeof state.output === "string")
    return { ...part, state: { ...state, output: filterLines(state.output, isSecret), metadata: {} } }
  return part
}

function filePart(part: any, isSecret: (p: string) => boolean) {
  const names = [part.source?.path, part.filename, typeof part.url === "string" && part.url.startsWith("file:") ? part.url : undefined]
  const p = names.find((n): n is string => typeof n === "string" && isSecret(n))
  if (!p) return part
  return { ...part, url: "data:text/plain,", source: part.source ? { ...part.source, text: { value: placeholder(p), start: 0, end: 0 } } : undefined }
}

/** Layer 1 over one message. Returns a deep copy; the input is not modified. */
export function message<M extends { info: any; parts: any[] }>(m: M, isSecret: (p: string) => boolean): M {
  const copy = structuredClone(m)
  const diffs = copy.info?.summary?.diffs
  if (Array.isArray(diffs))
    copy.info.summary.diffs = diffs.map((d: any) => (typeof d?.file === "string" && isSecret(d.file) ? { ...d, patch: placeholder(d.file) } : d))
  copy.parts = copy.parts.map((part: any) => {
    if (part?.type === "tool") return toolPart(part, isSecret)
    if (part?.type === "file") return filePart(part, isSecret)
    return part
  })
  return copy
}

/** Layer 2: every string, deep, through the audit writer's credential patterns. */
export function scan<T>(value: T): T {
  if (typeof value === "string") return Audit.redact(value) as T
  if (Array.isArray(value)) return value.map(scan) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scan(v)
    return out as T
  }
  return value
}

export function chunkMessages<M extends { info: any; parts: any[] }>(messages: readonly M[], directory: string, exclude: readonly string[]) {
  const isSecret = matcher(directory, exclude)
  return messages.map((m) => scan(message(m, isSecret)))
}
