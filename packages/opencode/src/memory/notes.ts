export * as MemoryNotes from "./notes"

import fs from "node:fs/promises"
import path from "node:path"
import type { MemoryBackend } from "./backend"
import type { MemoryStore } from "./store"

/**
 * Hand-written notes in `.opencode/memory/*.md` (the XCOD-85 convention) are part of project
 * memory (XCOD-94). They are written by people and reviewed in git, so they go in as trusted facts
 * without the approval prompt, one fact per paragraph, with the file as their source.
 *
 * The files stay the source of truth: when project memory starts, paragraphs that are new are
 * remembered, and facts whose paragraph has been edited or deleted are forgotten.
 *
 * A note written by `lunos memory import` (XCOD-133) starts with a marker comment saying where it
 * came from. It is not a paragraph; facts from that file are stamped `imported`, with the marker's
 * origin, so recall labels them.
 */

export const SESSION = "notes"

export interface Marker {
  imported: MemoryStore.Imported
  origin?: MemoryStore.Provenance
}

const MARKER = /^<!--\s*lunos-import\s+(\{[\s\S]*\})\s*-->$/

/** The first line of an imported note. `>` is escaped so nothing in it can close the comment. */
export function marker(value: Marker) {
  return `<!-- lunos-import ${JSON.stringify(value).replace(/>/g, "\\u003e")} -->`
}

export function readMarker(text: string): Marker | undefined {
  const first =
    text
      .trimStart()
      .split(/\n\s*\n/)[0]
      ?.trim() ?? ""
  const match = first.match(MARKER)
  if (!match) return
  try {
    const value = JSON.parse(match[1]) as Marker
    if (typeof value?.imported?.from !== "string" || typeof value.imported.date !== "string") return
    return value
  } catch {
    return
  }
}

function dir(worktree: string) {
  return path.join(worktree, ".opencode", "memory")
}

async function files(worktree: string) {
  const entries = await fs.readdir(dir(worktree), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir(worktree), entry.name))
    .toSorted()
}

/** Every note file's name and text, in name order. */
export async function read(worktree: string) {
  const out: { name: string; text: string }[] = []
  for (const file of await files(worktree))
    out.push({ name: path.basename(file), text: await fs.readFile(file, "utf8") })
  return out
}

export async function any(worktree: string) {
  return (await files(worktree)).length > 0
}

export function paragraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !/^#+\s/.test(paragraph) && paragraph !== "---" && !MARKER.test(paragraph))
}

export async function sync(input: { backend: MemoryBackend.Backend; worktree: string }) {
  const wanted = new Map<string, string>()
  const markers = new Map<string, Marker>()
  for (const file of await files(input.worktree)) {
    const source = path.relative(input.worktree, file).split(path.sep).join("/")
    const text = await fs.readFile(file, "utf8")
    const found = readMarker(text)
    if (found) markers.set(source, found)
    for (const paragraph of paragraphs(text)) wanted.set(`${source}\n${paragraph}`, source)
  }
  const existing = (await input.backend.list()).filter((fact) => fact.provenance.sessionID === SESSION)
  const have = new Set(existing.map((fact) => `${fact.provenance.source}\n${fact.text}`))
  for (const fact of existing)
    if (!wanted.has(`${fact.provenance.source}\n${fact.text}`)) await input.backend.forget(fact.id)
  const skipped: string[] = []
  for (const [key, source] of wanted) {
    if (have.has(key)) continue
    // One bad paragraph (too long, say) must not stop memory from starting.
    const imported = markers.get(source)
    await input.backend
      .remember(
        key.slice(source.length + 1),
        {
          sessionID: SESSION,
          agent: "user",
          source,
          date: new Date().toISOString(),
        },
        imported ? { imported: imported.imported, origin: imported.origin, kind: "observed" } : { kind: "observed" },
      )
      .catch((error: Error) => skipped.push(`${source}: ${error.message}`))
  }
  return { skipped }
}
