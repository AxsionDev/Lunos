export * as MemoryNotes from "./notes"

import fs from "node:fs/promises"
import path from "node:path"
import type { MemoryBackend } from "./backend"

/**
 * Hand-written notes in `.opencode/memory/*.md` (the XCOD-85 convention) are part of project
 * memory (XCOD-94). They are written by people and reviewed in git, so they go in as trusted facts
 * without the approval prompt, one fact per paragraph, with the file as their source.
 *
 * The files stay the source of truth: when project memory starts, paragraphs that are new are
 * remembered, and facts whose paragraph has been edited or deleted are forgotten.
 */

export const SESSION = "notes"

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

export async function any(worktree: string) {
  return (await files(worktree)).length > 0
}

export function paragraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !/^#+\s/.test(paragraph) && paragraph !== "---")
}

export async function sync(input: { backend: MemoryBackend.Backend; worktree: string }) {
  const wanted = new Map<string, string>()
  for (const file of await files(input.worktree)) {
    const source = path.relative(input.worktree, file).split(path.sep).join("/")
    for (const paragraph of paragraphs(await fs.readFile(file, "utf8"))) wanted.set(`${source}\n${paragraph}`, source)
  }
  const existing = (await input.backend.list()).filter((fact) => fact.provenance.sessionID === SESSION)
  const have = new Set(existing.map((fact) => `${fact.provenance.source}\n${fact.text}`))
  for (const fact of existing)
    if (!wanted.has(`${fact.provenance.source}\n${fact.text}`)) await input.backend.forget(fact.id)
  const skipped: string[] = []
  for (const [key, source] of wanted) {
    if (have.has(key)) continue
    // One bad paragraph (too long, say) must not stop memory from starting.
    await input.backend
      .remember(key.slice(source.length + 1), {
        sessionID: SESSION,
        agent: "user",
        source,
        date: new Date().toISOString(),
      })
      .catch((error: Error) => skipped.push(`${source}: ${error.message}`))
  }
  return { skipped }
}
