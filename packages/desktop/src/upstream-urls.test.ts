import { expect, test } from "bun:test"
import path from "node:path"

// XCOD-123: the desktop app must never update from, install from, or link to upstream opencode.
// A Lunos build that pointed its updater at anomalyco/opencode offered users a "downgrade" to
// upstream. This fails on any such URL in the desktop package's own code, scripts or config.
const ROOT = path.join(import.meta.dir, "..")
const UPSTREAM = /anomalyco\/|github\.com\/sst\/|sst-dev|opencode\.ai|owner:\s*"anomalyco"/
const SKIP = [/\.test\.tsx?$/, /\/i18n\//, /^src\/main\/migrate\.ts$/]
const TYPES = /\.(?:ts|tsx|js|mjs|json|ya?ml|xml|desktop|html)$/

test("no update, install or link URL points at upstream opencode", async () => {
  // Tracked files only: skips node_modules and build output, and gives "/" paths on Windows too.
  const files = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString().split("\n")
  expect(files.length).toBeGreaterThan(20)
  const hits: string[] = []
  for (const file of files) {
    if (!TYPES.test(file) || SKIP.some((pattern) => pattern.test(file))) continue
    const lines = (await Bun.file(path.join(ROOT, file)).text()).split("\n")
    lines.forEach((line, index) => {
      if (UPSTREAM.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  expect(hits).toEqual([])
})
