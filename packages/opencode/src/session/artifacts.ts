import path from "path"
import { readdir, readFile } from "fs/promises"
import type { InstanceContext } from "@/project/instance-context"
import { artifactDir } from "./session"

/**
 * The plans, research notes and dev-cycle records agents write (XCOD-84). They're plain markdown
 * files, and the files stay the source of truth: under VCS they live in the worktree's
 * `.opencode/`, where they can be committed and reviewed like any other doc. This only finds them.
 */
export const KINDS = [
  { kind: "plan", dir: "plans" },
  { kind: "research", dir: "research" },
  { kind: "dev-cycle", dir: "dev-cycle" },
] as const

export type Kind = (typeof KINDS)[number]["kind"]

export interface Item {
  kind: Kind
  title: string
  path: string
  created: number
}

// Files are named `<created-ms>-<slug>.md`; the title is the first markdown heading, else the slug.
async function describe(kind: Kind, file: string): Promise<Item | undefined> {
  const name = path.basename(file, ".md")
  const match = name.match(/^(\d+)-(.+)$/)
  if (!match) return
  const text = await readFile(file, "utf8").catch(() => "")
  const heading = text.match(/^#{1,3}\s+(.+?)\s*$/m)?.[1]
  return { kind, title: heading ?? match[2]!, path: file, created: Number(match[1]) }
}

/** Every artifact in this project, newest first, optionally one kind only. */
export async function list(instance: InstanceContext, kind?: Kind): Promise<Item[]> {
  const items: Item[] = []
  for (const entry of KINDS) {
    if (kind && entry.kind !== kind) continue
    const dir = artifactDir(entry.dir, instance)
    const files = await readdir(dir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const item = await describe(entry.kind, path.join(dir, file))
      if (item) items.push(item)
    }
  }
  return items.toSorted((a, b) => b.created - a.created)
}

export * as SessionArtifacts from "./artifacts"
