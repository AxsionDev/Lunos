import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"

// XCOD-285: "same look and feel" means interactions, layout and wording, built with Lunos components
// and the user's theme: no Anthropic or OpenAI logo, wordmark, mascot or brand art in the terminal
// app or the docs, and the docs keep the line that Lunos isn't affiliated with either.

const ROOT = path.join(import.meta.dir, "..", "..", "..", "..")
const IMAGE = /\.(svg|png|jpe?g|gif|webp|ico|bmp|avif)$/i
const VENDOR = /anthropic|openai|claude|codex|chatgpt|clawd/i

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return []
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : [full]
  })
}

test("no vendor logo or brand image in the terminal app or the docs", () => {
  const found = [path.join(ROOT, "packages", "tui"), path.join(ROOT, "docs")]
    .flatMap(files)
    .filter((file) => IMAGE.test(file) && VENDOR.test(path.basename(file)))
  expect(found).toEqual([])
})

test("the docs keep the line that Lunos isn't affiliated with Anthropic or OpenAI", () => {
  const line =
    "Claude Code is a product of Anthropic; Codex is a product of OpenAI. Lunos is not affiliated with either"
  for (const doc of ["external-agents.md", "external-what-lunos-adds.md"])
    expect(readFileSync(path.join(ROOT, "docs", doc), "utf8")).toContain(line)
})
