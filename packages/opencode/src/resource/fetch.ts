export * as ResourceFetch from "./fetch"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { ResourceConvert } from "./convert"
import { ResourceSecrets } from "./secrets"

/**
 * Reading a resource's content (XCOD-300): a folder or file on this computer, a web page and the
 * same-site pages it links to, or an MCP resource. Nothing here decides whether a resource may be
 * read; callers pass a `gate` for every URL, and the folder walk never leaves the folder.
 */

export interface Doc {
  source: string
  text?: string
  /** A PNG/JPG, or a PDF a model may read directly: attached, never indexed. */
  file?: { mime: string; path?: string; data?: string }
}

export interface Skipped {
  source: string
  reason: string
}

export interface Loaded {
  docs: Doc[]
  skipped: Skipped[]
  bytes: number
  /** Files in which the credential scanner masked something. */
  redacted: number
  /** Set when a size cap stopped reading early. */
  truncated?: string
}

export interface Limits {
  maxBytes: number
  maxFiles?: number
}

const MAX_FILES = 20_000
const MB = 1024 * 1024

function empty(): Loaded {
  return { docs: [], skipped: [], bytes: 0, redacted: 0 }
}

function text(out: Loaded, source: string, value: string) {
  const masked = ResourceSecrets.redact(value)
  if (masked.redacted) out.redacted++
  out.docs.push({ source, text: masked.text })
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** A file or a folder, walked without following links out of it, minus secrets and excluded files. */
export async function local(
  target: string,
  input: Limits & { include?: readonly string[]; exclude?: readonly string[] },
): Promise<Loaded> {
  const out = empty()
  const stat = await fs.stat(target)
  const root = await fs.realpath(stat.isDirectory() ? target : path.dirname(target))
  const include = (input.include?.length ? input.include : ["**/*"]).map((glob) => new Bun.Glob(glob))
  const exclude = (input.exclude ?? []).map((glob) => new Bun.Glob(glob))
  const maxFiles = input.maxFiles ?? MAX_FILES
  let files = 0

  const read = async (file: string, relative: string) => {
    if (ResourceSecrets.secretPath(relative)) return out.skipped.push({ source: relative, reason: "secret" })
    const real = await fs.realpath(file).catch(() => undefined)
    if (!real || !inside(root, real))
      return out.skipped.push({ source: relative, reason: "links outside the resource's folder" })
    if (ResourceSecrets.secretPath(path.basename(real))) return out.skipped.push({ source: relative, reason: "secret" })
    const size = (await fs.stat(real)).size
    if (out.bytes + size > input.maxBytes) {
      out.truncated = `stopped at ${Math.round(input.maxBytes / MB)} MB (resources.max_resource_mb)`
      return
    }
    if (++files > maxFiles) {
      out.truncated = `stopped at ${maxFiles} files`
      return
    }
    const ext = path.extname(real).toLowerCase()
    if (ResourceConvert.IMAGE[ext] || ext === ".pdf") {
      const converted = ResourceConvert.convert(real, new Uint8Array())
      out.bytes += size
      if (converted.kind === "image") out.docs.push({ source: relative, file: { mime: converted.mime, path: real } })
      if (converted.kind === "document") {
        out.docs.push({ source: relative, file: { mime: converted.mime, path: real } })
        out.skipped.push({ source: relative, reason: converted.reason })
      }
      return
    }
    const bytes = new Uint8Array(await fs.readFile(real))
    const converted = ResourceConvert.convert(real, bytes)
    if (converted.kind !== "text") {
      if (converted.kind === "skip" && converted.reason !== "binary file")
        out.skipped.push({ source: relative, reason: converted.reason })
      return
    }
    out.bytes += size
    text(out, relative, converted.text)
  }

  if (!stat.isDirectory()) {
    await read(target, path.basename(target))
    return out
  }

  const walk = async (dir: string, prefix: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (out.truncated) return
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ResourceSecrets.SKIP_DIRS.has(entry.name)) continue
        if (exclude.some((glob) => glob.match(relative) || glob.match(`${relative}/`))) continue
        await walk(full, relative)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (!include.some((glob) => glob.match(relative))) continue
      if (exclude.some((glob) => glob.match(relative))) continue
      // A link to a folder isn't followed: only files are read, and only inside the folder.
      if (entry.isSymbolicLink()) {
        const real = await fs.realpath(full).catch(() => undefined)
        if (real && (await fs.stat(real)).isDirectory()) continue
      }
      await read(full, relative)
    }
  }
  await walk(root, "")
  return out
}

/**
 * A local resource's signature: every included file's path, size and modification time. Cheap
 * (no file is read), so a folder the watcher doesn't cover can still be checked for changes.
 */
export async function stamp(
  target: string,
  entry?: { include?: readonly string[]; exclude?: readonly string[] },
): Promise<string> {
  const include = (entry?.include?.length ? entry.include : ["**/*"]).map((glob) => new Bun.Glob(glob))
  const exclude = (entry?.exclude ?? []).map((glob) => new Bun.Glob(glob))
  const hash = crypto.createHash("sha256")
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat) return "missing"
  if (!stat.isDirectory()) return `${stat.size}:${stat.mtimeMs}`
  let files = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const item of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (++files > MAX_FILES) return
      const relative = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (ResourceSecrets.SKIP_DIRS.has(item.name)) continue
        if (exclude.some((glob) => glob.match(relative) || glob.match(`${relative}/`))) continue
        await walk(path.join(dir, item.name), relative)
        continue
      }
      if (!include.some((glob) => glob.match(relative)) || exclude.some((glob) => glob.match(relative))) continue
      const info = await fs.stat(path.join(dir, item.name)).catch(() => undefined)
      if (info) hash.update(`${relative}\0${info.size}\0${info.mtimeMs}\n`)
    }
  }
  await walk(target, "")
  return hash.digest("hex").slice(0, 16)
}

export type Gate = (url: string) => string | undefined

export interface WebInput extends Limits {
  depth: number
  gate: Gate
  timeoutMs?: number
  maxPages?: number
  fetch?: typeof fetch
}

const PAGE_BYTES = 5 * MB
const MAX_REDIRECTS = 5

export class RefusedError extends Error {
  override name = "ResourceRefused"
}

function normal(url: URL) {
  const next = new URL(url.href)
  next.hash = ""
  return next.href
}

/** The `href`s of a page, resolved, on the same site, without fragments. */
export function links(html: string, base: URL) {
  const out = new Set<string>()
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = match[1] ?? match[2] ?? match[3] ?? ""
    let url: URL
    try {
      url = new URL(href, base)
    } catch {
      continue
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue
    if (url.host !== base.host) continue
    if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|gz|tar|mp4|mp3|css|js|ico|woff2?)$/i.test(url.pathname)) continue
    out.add(normal(url))
  }
  return [...out]
}

/**
 * A page, and up to `depth` levels of the same-site pages it links to. Every URL, including each
 * redirect's target, goes through `gate` first; a redirect to another site is refused. Each request
 * has a timeout, and the crawl stops at `maxPages` or the size cap.
 */
export async function web(start: string, input: WebInput): Promise<Loaded> {
  const out = empty()
  const first = new URL(start)
  const refusal = input.gate(first.href)
  if (refusal) throw new RefusedError(refusal)
  const get = input.fetch ?? fetch
  const maxPages = input.maxPages ?? 50
  const seen = new Set<string>([normal(first)])
  let level = [normal(first)]
  let pages = 0

  const one = async (href: string) => {
    let url = new URL(href)
    for (let hop = 0; ; hop++) {
      const reason = input.gate(url.href)
      if (reason) return out.skipped.push({ source: url.href, reason })
      const response = await get(url.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
        headers: { Accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8", "User-Agent": "lunos" },
      })
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        const next = new URL(response.headers.get("location")!, url)
        if (next.host !== first.host)
          return out.skipped.push({ source: url.href, reason: `redirects to another site (${next.host})` })
        if (hop >= MAX_REDIRECTS) return out.skipped.push({ source: url.href, reason: "too many redirects" })
        url = next
        continue
      }
      if (!response.ok) return out.skipped.push({ source: url.href, reason: `HTTP ${response.status}` })
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.byteLength > PAGE_BYTES) return out.skipped.push({ source: url.href, reason: "larger than 5 MB" })
      if (out.bytes + body.byteLength > input.maxBytes) {
        out.truncated = `stopped at ${Math.round(input.maxBytes / MB)} MB (resources.max_resource_mb)`
        return
      }
      out.bytes += body.byteLength
      const raw = new TextDecoder().decode(body)
      if (type === "text/html" || type === "application/xhtml+xml") {
        const converted = ResourceConvert.convert("page.html", body)
        if (converted.kind === "text") text(out, url.href, converted.text)
        return links(raw, url)
      }
      if (type.startsWith("text/")) return text(out, url.href, raw)
      return out.skipped.push({ source: url.href, reason: `not a text page (${type || "no content type"})` })
    }
  }

  for (let depth = 0; depth <= input.depth && level.length; depth++) {
    const next: string[] = []
    for (const href of level) {
      if (pages >= maxPages) {
        out.truncated = `stopped at ${maxPages} pages`
        break
      }
      if (out.truncated) break
      pages++
      const found = await one(href).catch((error: unknown) => {
        out.skipped.push({ source: href, reason: error instanceof Error ? error.message : String(error) })
      })
      if (!Array.isArray(found) || depth === input.depth) continue
      for (const link of found) {
        if (seen.has(link)) continue
        seen.add(link)
        next.push(link)
      }
    }
    level = next
  }
  return out
}

export interface McpContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

/** An MCP resource's contents: text is redacted and indexed, PNG/JPG blobs are attached. */
export function mcp(contents: readonly McpContent[], limits: Limits): Loaded {
  const out = empty()
  for (const item of contents) {
    const size = item.text?.length ?? Math.floor(((item.blob?.length ?? 0) * 3) / 4)
    if (out.bytes + size > limits.maxBytes) {
      out.truncated = `stopped at ${Math.round(limits.maxBytes / MB)} MB (resources.max_resource_mb)`
      break
    }
    out.bytes += size
    if (item.text !== undefined) text(out, item.uri, item.text)
    else if (item.blob && (item.mimeType === "image/png" || item.mimeType === "image/jpeg"))
      out.docs.push({ source: item.uri, file: { mime: item.mimeType, data: item.blob } })
    else out.skipped.push({ source: item.uri, reason: `binary content (${item.mimeType ?? "unknown type"})` })
  }
  return out
}
