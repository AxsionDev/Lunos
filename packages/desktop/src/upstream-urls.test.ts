import { expect, test } from "bun:test"
import path from "node:path"

// XCOD-123: the desktop app must never update from, install from, or link to upstream opencode.
// A Lunos build that pointed its updater at anomalyco/opencode offered users a "downgrade" to
// upstream. This fails on any such URL in the desktop package's own code, scripts or config.
const ROOT = path.join(import.meta.dir, "..")
const UPSTREAM = /anomalyco\/|github\.com\/sst\/|sst-dev|opencode\.ai|owner:\s*"anomalyco"/
const SKIP = [/node_modules\//, /\.test\.tsx?$/, /\/i18n\//, /^dist\//, /^out\//, /^src\/main\/migrate\.ts$/]

test("no update, install or link URL points at upstream opencode", async () => {
  const hits: string[] = []
  for await (const file of new Bun.Glob("**/*.{ts,tsx,js,mjs,json,yml,yaml,xml,desktop,html}").scan(ROOT)) {
    if (SKIP.some((pattern) => pattern.test(file))) continue
    const lines = (await Bun.file(path.join(ROOT, file)).text()).split("\n")
    lines.forEach((line, index) => {
      if (UPSTREAM.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  expect(hits).toEqual([])
})
