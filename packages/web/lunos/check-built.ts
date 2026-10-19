#!/usr/bin/env bun

// XCOD-124: fails if the built Lunos docs show "opencode" anywhere a reader would see it (page
// text, links, image sources, meta tags) outside the allow-list: identifiers the Lunos binary
// still reads, third-party names, and the fork page. Run after `bun run build`.
//
//   bun lunos/check-built.ts [dist/docs]

import path from "path"
import { EXCLUDED_PAGES } from "./excluded.mjs"

/** Uses of "opencode" that are correct in Lunos docs. Explained on the "Lunos and opencode" page. */
export const ALLOWED: RegExp[] = [
  /(?:https:\/\/)?opencode\.ai\/(?:config|tui|theme)\.json/g,
  /\bopencode\.jsonc?\b/g,
  /\bopencode\.local\b/g,
  /\.well-known\/opencode\b/g,
  // Directories: ~/.config/opencode, ~/.local/share/opencode, ~/Library/Application Support/opencode...
  /(?:\.config|share|\.cache|state|Support|Roaming|Local)[\\/]opencode\b/g,
  /(?<![\w-])\.opencode\b/g,
  /\b[A-Z_]*OPENCODE[A-Z_]*\b/g,
  /@opencode-ai\/[\w-]+/g,
  /\bai\.opencode\.[\w.]+/g,
  /\bcreateOpencode(?:Client|Server)?\b/g,
  /\bx-opencode-[\w-]+/g,
  /\bopencode-(?!ai\b|docs\b)[\w-]+/g,
  /\bopencode\.nvim\b/g,
  /using-opencodejson/g, // heading anchor for "Using opencode.json"
  /Lunos and opencode/g, // the fork page's title, in every page's sidebar
  /github\.com\/(?!anomalyco\/)[\w.-]+\/[\w.-]*opencode[\w.-]*/g,
]

/** Pages where naming opencode is the point. */
export const ALLOWED_PAGES = ["lunos-fork/index.html"]

/** What a reader sees: text outside scripts and styles, plus link, image and meta values. */
export function visible(html: string) {
  const attrs = [...html.matchAll(/\s(?:href|src|content|alt|title)="([^"]*)"/g)].map((m) => decodeURIComponent(m[1]))
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
  return [text, ...attrs].join("\n")
}

/** Links to pages the Lunos build leaves out (lunos/prepare.ts EXCLUDED_PAGES). */
const DEAD_LINK = new RegExp(`href="/docs/(?:${EXCLUDED_PAGES.join("|")})/?[#"]`, "g")
/** Names the rebrand could invent for things that don't exist. */
const INVENTED = /\bLunos (?:Zen|Go)\b|\bLunos\.ai\b|anomalyco\/(?:tap\/)?Lunos\b/gi

export function findings(html: string) {
  let text = visible(html)
  for (const pattern of ALLOWED) text = text.replace(pattern, "")
  const context = (pattern: RegExp, source: string) =>
    [...source.matchAll(new RegExp(`.{0,60}(?:${pattern.source}).{0,60}`, "gi"))].map((m) =>
      m[0].replace(/\s+/g, " ").trim(),
    )
  return [
    ...context(/opencode/, text),
    ...context(INVENTED, visible(html)),
    ...[...html.matchAll(DEAD_LINK)].map((m) => `link to an excluded page: ${m[0]}`),
  ]
}

if (import.meta.main) {
  const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../dist/docs"))
  let pages = 0
  const problems: string[] = []
  for await (const file of new Bun.Glob("**/*.html").scan(dir)) {
    pages++
    if (ALLOWED_PAGES.includes(file)) continue
    for (const hit of findings(await Bun.file(path.join(dir, file)).text())) problems.push(`${file}: ${hit}`)
  }
  if (pages === 0) throw new Error(`check-built: no HTML in ${dir}; run bun run build first`)
  if (problems.length) {
    console.error(problems.join("\n"))
    console.error(`\ncheck-built: ${problems.length} upstream-branding mentions in ${pages} pages`)
    process.exit(1)
  }
  console.log(`check-built: ${pages} pages, no upstream branding outside the allow-list`)
}
