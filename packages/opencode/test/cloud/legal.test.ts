import { expect, test } from "bun:test"
import path from "path"
import { CloudLegal } from "../../src/cloud/legal"

// XCOD-275: the Terms and the Privacy notice, their versions and links, are Lunos Cloud's (GET
// /v1/legal); none are built into the client. The host's use of them (cache, offline, exemptions) is
// tested in signin.test.ts, and on screen in tui-signin-pty.test.ts.

const root = path.resolve(import.meta.dir, "../../../..")

test("no Terms or Privacy notice version or link is hard-coded in any package's source", async () => {
  const files = Bun.spawnSync(["git", "ls-files", "packages/*/src/**"], { cwd: root })
    .stdout.toString()
    .split("\n")
    .filter((file) => /\.(ts|tsx|js|mjs|json)$/.test(file))
  // A positive control: the scan covers the files that used to hold them.
  expect(files).toContain("packages/opencode/src/cloud/tui-host.ts")
  expect(files).toContain("packages/tui/src/component/welcome.tsx")
  const found: string[] = []
  const link = /lunos\.tech\/(terms|privacy)\b/
  const dated =
    /(terms|privacy|legal|consent)[^\n]{0,60}\b20\d\d-\d\d-\d\d\b|\b20\d\d-\d\d-\d\d\b[^\n]{0,60}(terms|privacy)/i
  // A date as a version ("version: \"2026-10-19\""), as the Terms' was.
  const versioned = /(^|[{,\s])["']?version["']?\s*:\s*["'`]20\d\d-\d\d-\d\d/
  for (const file of files) {
    const lines = (await Bun.file(path.join(root, file)).text()).split("\n")
    lines.forEach((line, index) => {
      if (link.test(line) || dated.test(line) || versioned.test(line))
        found.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  expect(found).toEqual([])
})

test("parse: both documents with a version and a web link, or nothing", () => {
  const legal = {
    terms: { version: "2026-10-19", url: "https://lunos.tech/terms" },
    privacy: { version: "2026-10-19", url: "https://lunos.tech/privacy" },
  }
  expect(CloudLegal.parse(legal)).toEqual(legal)
  expect(CloudLegal.parse({ terms: legal.terms })).toBeUndefined()
  expect(CloudLegal.parse({ ...legal, privacy: { version: "", url: legal.privacy.url } })).toBeUndefined()
  // Shown as a link to open: never a file: or javascript: URL.
  expect(CloudLegal.parse({ ...legal, terms: { version: "1", url: "file:///etc/passwd" } })).toBeUndefined()
  expect(CloudLegal.parse(undefined)).toBeUndefined()
})
