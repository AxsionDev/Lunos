#!/usr/bin/env bun

// Records which upstream opencode release this tree is based on (XCOD-90), so builds can show
// "Lunos v1.18.38 · based on opencode 1.18.31". The value is the upstream package version at the
// merge base with upstream/dev, i.e. the last upstream sync. CI checkouts have no `upstream`
// remote, so there it is a no-op and the checked-in value is used as-is.

import { $ } from "bun"
import path from "path"

const root = path.resolve(import.meta.dir, "..")
const file = path.join(root, "packages/opencode/package.json")

const base = (await $`git merge-base HEAD upstream/dev`.cwd(root).quiet().nothrow()).stdout.toString().trim()
if (!base) {
  console.log("upstream-version: no upstream/dev remote here; keeping the checked-in value")
  process.exit(0)
}

const upstream = JSON.parse(
  (await $`git show ${base}:packages/opencode/package.json`.cwd(root).quiet()).stdout.toString(),
).version as string

const text = await Bun.file(file).text()
const current = JSON.parse(text).lunos?.upstreamVersion
if (current === upstream) process.exit(0)

const next = text.replace(/("upstreamVersion":\s*)"[^"]*"/, `$1"${upstream}"`)
if (next === text) throw new Error(`upstream-version: no lunos.upstreamVersion field in ${file}`)
await Bun.write(file, next)
console.log(`upstream-version: ${current} -> ${upstream}`)
