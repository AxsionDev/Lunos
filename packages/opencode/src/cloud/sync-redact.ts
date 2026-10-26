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
export const NEVER = [".env*", "auth.json", "*.pem", "*.key", "id_rsa*"] as const

const placeholder = (p: string) => `[not synced: ${p}]`

export function matcher(directory: string, exclude: readonly string[]) {
  // Base names are matched case-insensitively (.ENV, ID_RSA, X.PEM): the globs and the name are lower-cased.
  const base = NEVER.map((g) => new Bun.Glob(g.toLowerCase()))
  const extra = exclude.map((g) => new Bun.Glob(g))
  return (p: string) => {
    p = p.replaceAll("\\", "/")
    const name = path.posix.basename(p)
    if (base.some((g) => g.match(name.toLowerCase()))) return true
    // `./a/b`, `a/../a/b` and absolute spellings of the same file all become the same relative path.
    const rel = path.relative(directory, path.resolve(directory, p)).replaceAll("\\", "/")
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
  if (typeof patch === "string")
    for (const re of [PATCH_FILE, MOVE_TO]) for (const m of patch.matchAll(re)) out.push(m[1]!.trim())
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
    // Each match row is followed by an empty line (ripgrep keeps the match's "\n"), so a blank line never
    // ends a secret group: only the next file header or the truncation trailer does.
    const header = !/^\s/.test(line) && line.endsWith(":")
    if (header) {
      const candidate = line.slice(0, -1)
      skipping = isSecret(candidate)
      kept.push(skipping ? placeholder(candidate) : line)
      continue
    }
    if (line.startsWith("(Results truncated")) skipping = false
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
    for (const [k, v] of Object.entries(state.input ?? {}))
      input[k] =
        PATH_KEYS.includes(k as any) || typeof v === "number" || typeof v === "boolean" || v == null ? v : blank
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
  const names = [
    part.source?.path,
    part.filename,
    typeof part.url === "string" && part.url.startsWith("file:") ? part.url : undefined,
  ]
  const p = names.find((n): n is string => typeof n === "string" && isSecret(n))
  if (!p) return part
  return {
    ...part,
    url: "data:text/plain,",
    source: part.source ? { ...part.source, text: { value: placeholder(p), start: 0, end: 0 } } : undefined,
  }
}

/** git's C-quoted path (`"caf\\303\\251.txt"`), as summary.ts reads it. */
function unquoteGitPath(input: string) {
  if (!input.startsWith('"') || !input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" }
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== "\\" || i + 1 >= body.length) {
      bytes.push(...Buffer.from(c))
      continue
    }
    const next = body[i + 1]!
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4))
    if (oct) {
      bytes.push(parseInt(oct[0], 8))
      i += oct[0].length
      continue
    }
    bytes.push(...Buffer.from(esc[next] ?? next))
    i++
  }
  return Buffer.from(bytes).toString()
}

const READ_CALL = "Called the Read tool with the following input: "

/**
 * An @-mention of a file makes prompt.ts store synthetic text parts next to the file part: "Called the
 * Read tool with the following input: {...}", then the file's content (or the read error). When the
 * call names a secret file, both go.
 */
function mentionParts(parts: any[], isSecret: (p: string) => boolean) {
  return parts.map((part, i) => {
    if (part?.type !== "text" || !part.synthetic || typeof part.text !== "string") return part
    const prev = parts[i - 1]
    const call = (t: unknown) => {
      if (typeof t !== "string" || !t.startsWith(READ_CALL)) return undefined
      try {
        const file = JSON.parse(t.slice(READ_CALL.length))?.filePath
        return typeof file === "string" && isSecret(file) ? file : undefined
      } catch {
        return undefined
      }
    }
    const own = call(part.text)
    if (own) return { ...part, text: placeholder(own) }
    const owner = prev?.type === "text" && prev.synthetic ? call(prev.text) : undefined
    return owner ? { ...part, text: placeholder(owner) } : part
  })
}

/** Layer 1 over one message. Returns a deep copy; the input is not modified. */
export function message<M extends { info: any; parts: any[] }>(m: M, isSecret: (p: string) => boolean): M {
  const copy = structuredClone(m)
  const diffs = copy.info?.summary?.diffs
  if (Array.isArray(diffs))
    copy.info.summary.diffs = diffs.map((d: any) =>
      typeof d?.file === "string" && isSecret(unquoteGitPath(d.file))
        ? {
            file: d.file,
            additions: d.additions,
            deletions: d.deletions,
            ...(d.status === undefined ? {} : { status: d.status }),
          }
        : d,
    )
  copy.parts = mentionParts(copy.parts, isSecret).map((part: any) => {
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

export function chunkMessages<M extends { info: any; parts: any[] }>(
  messages: readonly M[],
  directory: string,
  exclude: readonly string[],
) {
  const isSecret = matcher(directory, exclude)
  return messages.map((m) => scan(message(m, isSecret)))
}
