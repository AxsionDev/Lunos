export * as AgentFile from "./file"

import fs from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { configEntryNameFromPath } from "../config/entry-name"

/**
 * An agent's markdown file (XCOD-210): YAML front matter for the definition, the prompt as the
 * body. Import (XCOD-209) and edit write it through `render` only, so both produce the same file.
 */

export type Doc = Record<string, unknown> & { prompt?: unknown }

/** The file's text for an agent definition. The prompt becomes the body. */
export function render(doc: Doc) {
  const { prompt, ...frontmatter } = doc
  return matter.stringify(typeof prompt === "string" ? prompt : "", frontmatter)
}

/** An agent file's definition, prompt included. YAML front matter only (XCOD-208). */
export function parse(text: string): Doc {
  const md = ConfigMarkdown.parse(text)
  return { ...(md.data as Record<string, unknown>), prompt: md.content.trim() }
}

/**
 * The markdown file that defines agent `name` in one of these config directories, the way the
 * config loader names them (`agents/review/strict.md` is `review/strict`). The last directory wins,
 * as it does when config loads. `.claude/agents` files aren't Lunos's to rewrite, so they're skipped.
 */
export async function locate(directories: readonly string[], name: string) {
  let found: string | undefined
  for (const dir of directories) {
    if (path.basename(dir) === ".claude") continue
    for (const file of await Glob.scan("{agent,agents}/**/*.md", {
      cwd: dir,
      absolute: true,
      dot: true,
      symlink: true,
    }))
      if (configEntryNameFromPath(path.relative(dir, file), ["agent/", "agents/"]) === name) found = file
  }
  return found
}

export async function read(file: string) {
  return parse(await fs.readFile(file, "utf8"))
}
