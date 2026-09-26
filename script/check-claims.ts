#!/usr/bin/env bun
// XCOD-108: the claim table in the sovereignty decision record (XCOD-55) is the one list of what
// Lunos does and doesn't claim. This check fails when a document that reproduces it disagrees on a
// verdict, or when public docs use a phrasing the wording rules forbid. It is the drift XCOD-63
// had to correct by hand.
//
//   bun script/check-claims.ts        (exit 1 on any disagreement)

import path from "path"

export const SOURCE = ".claude/docs/xcod-55-infrastructure-sovereignty-decision.md"
/** Documents that reproduce the claim table. */
export const COPIES = ["docs/deployment/self-hosted.md"]
/** Public documents the wording rules apply to. */
export const PUBLIC = ["README.md", "CHANGELOG.md", "docs/**/*.md"]

// From the decision record's wording rules (❌). A line stating the rule itself is allowed.
export const FORBIDDEN: readonly RegExp[] = [
  /EU-sovereign infrastructure/i,
  /sovereign cloud/i,
  /\b(CRA|EUCS|ISO ?27001|SOC ?2)[- ]certifi(ed|cation)\b/i,
]

const normalise = (claim: string) => claim.replace(/[_*`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()

/** Claim → verdict ("yes", "no", "n/a") from the first markdown table whose header starts with "Claim". */
export function claimTable(markdown: string) {
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => /^\|\s*Claim\s*\|/i.test(line))
  const table = new Map<string, string>()
  if (start === -1) return table
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break
    const [claim, verdict] = line.split("|").slice(1, 3)
    const word = verdict?.match(/\*\*([^*]+)\*\*/)?.[1] ?? verdict ?? ""
    table.set(normalise(claim ?? ""), normalise(word).split(/[ ,(]/)[0])
  }
  return table
}

export function compare(source: Map<string, string>, copy: Map<string, string>) {
  const problems: string[] = []
  for (const [claim, verdict] of source) {
    if (!copy.has(claim)) problems.push(`missing claim: "${claim}"`)
    else if (copy.get(claim) !== verdict)
      problems.push(`"${claim}": the decision record says ${verdict}, this document says ${copy.get(claim)}`)
  }
  for (const claim of copy.keys()) if (!source.has(claim)) problems.push(`claim not in the decision record: "${claim}"`)
  return problems
}

export function forbidden(markdown: string) {
  return markdown
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !line.includes("❌") && FORBIDDEN.some((pattern) => pattern.test(line)))
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..")
  const read = (file: string) => Bun.file(path.join(root, file)).text()
  const source = claimTable(await read(SOURCE))
  const problems: string[] = []
  for (const copy of COPIES)
    for (const problem of compare(source, claimTable(await read(copy)))) problems.push(`${copy}: ${problem}`)
  for (const pattern of PUBLIC)
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root }))
      for (const hit of forbidden(await read(file)))
        problems.push(`${file}:${hit.number}: forbidden wording: ${hit.line.trim()}`)
  if (problems.length) {
    console.error(problems.join("\n"))
    process.exit(1)
  }
  console.log(`claims consistent: ${source.size} claims, ${COPIES.length} copy, public docs clean`)
}
