#!/usr/bin/env bun

// Records which upstream opencode release this tree is based on (XCOD-90), so builds can show
// "Lunos v1.18.38 · based on opencode 1.18.31". The value is the upstream package version at the
// merge base with the upstream ref, i.e. the last upstream sync.
//
//   bun script/upstream-version.ts [--upstream <ref>]
//
// Lunos tracks upstream's v1 release tags (see script/upstream-sync.ts), fetched into
// refs/upstream-tags/*. Without --upstream, the newest such local tag is used. CI checkouts and
// clones that never fetched one have nothing to compare with, so there it is a no-op and the
// checked-in value is used as-is.

import { $ } from "bun"
import path from "path"
import { TAG_NAMESPACE, latestReleaseTag } from "./upstream-sync"

const root = path.resolve(import.meta.dir, "..")
const file = path.join(root, "packages/opencode/package.json")

async function defaultRef() {
  const out = await $`git for-each-ref ${"--format=%(refname:lstrip=2)"} ${TAG_NAMESPACE}`.cwd(root).quiet().nothrow()
  const tag = latestReleaseTag(out.stdout.toString().split("\n").filter(Boolean))
  return tag ? `${TAG_NAMESPACE}/${tag}` : undefined
}

const index = process.argv.indexOf("--upstream")
const ref = index === -1 ? await defaultRef() : process.argv[index + 1]
const base = ref ? (await $`git merge-base HEAD ${ref}`.cwd(root).quiet().nothrow()).stdout.toString().trim() : ""
if (!base) {
  console.log(`upstream-version: no upstream release tag in ${TAG_NAMESPACE} here; keeping the checked-in value`)
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
