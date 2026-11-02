// XCOD-217: the repository page and the npm page show the Lunos logo, never upstream's. The
// upstream logo files stay in the tree (upstream console code uses them, and deleting them would
// conflict in every upstream sync); only the READMEs must not point at them.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..", "..", "..")
const readmes = [
  ...fs.readdirSync(root).filter((name) => /^README(\.[a-z]+)?\.md$/.test(name)),
  "packages/opencode/script/npm-readme.md",
]
// Image references: <img src>, <source srcset>, and markdown ![alt](url).
const images = (text: string) => [
  ...[...text.matchAll(/<(?:img|source)\b[^>]*\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]),
  ...[...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]),
]

describe("README branding (XCOD-217)", () => {
  test("the READMEs exist", () => {
    expect(readmes.length).toBeGreaterThanOrEqual(22)
  })

  for (const file of readmes)
    test(`${file} shows the Lunos logo and no upstream image`, () => {
      const text = fs.readFileSync(path.join(root, file), "utf8")
      const refs = images(text)
      expect(refs.filter((ref) => /opencode|logo-ornate/i.test(ref))).toEqual([])
      expect(refs.some((ref) => ref.includes("assets/brand/lunos-logo-"))).toBe(true)
    })

  test("every logo the READMEs use is in the repository", () => {
    for (const file of ["lunos-logo-light.svg", "lunos-logo-dark.svg", "lunos-logo-light.png", "lunos-logo-dark.png"])
      expect(fs.existsSync(path.join(root, "assets", "brand", file))).toBe(true)
  })
})
