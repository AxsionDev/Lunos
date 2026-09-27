#!/usr/bin/env bun

// XCOD-124: builds the Lunos docs content from upstream's English pages. Writes
// src/content/lunos-docs/ (gitignored), which the docs collection loads instead of
// src/content/docs/:
//   - English pages only: the 17 locale folders aren't rebranded, so they aren't published yet
//   - upstream product pages and sections removed (EXCLUDED_PAGES, DROPPED_SECTIONS)
//   - rebrand() applied to every page
//   - Lunos-owned pages from lunos/pages/ added as they are

import fs from "fs/promises"
import path from "path"
import { dropSections, rebrand } from "./rebrand"
import { applyPatches } from "./patches"
import { EXCLUDED_PAGES } from "./excluded.mjs"

const web = path.resolve(import.meta.dir, "..")
const SOURCE = path.join(web, "src/content/docs")
const OUT = path.join(web, "src/content/lunos-docs")
const PAGES = path.join(import.meta.dir, "pages")

/** Sections of kept pages that describe upstream's hosted products. */
export const DROPPED_SECTIONS: Record<string, string[]> = {
  // "OpenCode Zen" twice: the `##` section, then the `###` entry in the provider directory.
  providers: ["OpenCode Zen", "OpenCode Go", "OpenCode Zen"],
  index: ["Share"],
}

export async function prepare() {
  await fs.rm(OUT, { recursive: true, force: true })
  await fs.mkdir(OUT, { recursive: true })
  const written: string[] = []
  for (const entry of await fs.readdir(SOURCE, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.mdx?$/.test(entry.name)) continue
    const id = entry.name.replace(/\.mdx?$/, "")
    if (EXCLUDED_PAGES.includes(id)) continue
    let text = await Bun.file(path.join(SOURCE, entry.name)).text()
    if (DROPPED_SECTIONS[id]) text = dropSections(text, DROPPED_SECTIONS[id])
    text = applyPatches(id, text)
    // Pages import `../../../config.mjs`; point them at Lunos's overrides of it.
    text = text.replaceAll('from "../../../config.mjs"', 'from "../../../lunos/config.mjs"')
    await Bun.write(path.join(OUT, entry.name), rebrand(text))
    written.push(entry.name)
  }
  for (const name of await fs.readdir(PAGES)) {
    await fs.copyFile(path.join(PAGES, name), path.join(OUT, name))
    written.push(name)
  }
  return written
}

if (import.meta.main) {
  const written = await prepare()
  console.log(`lunos docs: ${written.length} pages in src/content/lunos-docs`)
}
