#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = `v${Script.version}`

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

async function prepareReleaseFiles() {
  for (const file of pkgjsons) {
    let pkg = await Bun.file(file).text()
    pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
    console.log("updated:", file)
    await Bun.file(file).write(pkg)
  }

  await $`bun install`
  await $`./packages/sdk/js/script/build.ts`
}

if (Script.release && !Script.preview) {
  await $`git fetch origin --tags`
  await $`git switch --detach`
}

await prepareReleaseFiles()

console.log("\n=== cli ===\n")
await $`bun ./packages/opencode/script/publish.ts`

// XCOD-49: the sdk, plugin and ui packages are still named @opencode-ai/* — upstream's scope on
// npm — so publishing them fails 403 and takes the whole release down with it. Skipped by
// default rather than renamed: the CLI is a bundled binary that does not depend on them at
// runtime, and they only matter once third parties build integrations against Lunos.
//
// To enable, first give them a Lunos-owned name (a scope needs an npm organisation), then set
// LUNOS_PUBLISH_LIBS=1.
if (process.env.LUNOS_PUBLISH_LIBS === "1") {
  console.log("\n=== sdk ===\n")
  await $`bun ./packages/sdk/js/script/publish.ts`

  console.log("\n=== plugin ===\n")
  await $`bun ./packages/plugin/script/publish.ts`

  console.log("\n=== ui ===\n")
  await $`bun ./packages/ui/script/publish.ts`
} else {
  console.log("\n=== sdk / plugin / ui: skipped ===")
  console.log("still named @opencode-ai/* (upstream's npm scope); set LUNOS_PUBLISH_LIBS=1 once renamed\n")
}

if (Script.release) {
  // XCOD-49: finalize-latest-json.ts signs each desktop bundle with the Tauri updater key. This
  // fork has no TAURI_SIGNING_PRIVATE_KEY, so `tauri signer sign` failed with "Missing comment in
  // secret key" and took the whole release down at line 63 — after npm and ghcr had both fully
  // published, but before the tag, the dev sync and `--draft=false` below. The desktop app is not
  // required for Phase 0 exit (XCOD-20 is CLI-only), so a missing updater key must not block a CLI
  // release. Keyed off the secret's presence rather than a manual flag: this starts working on its
  // own the moment XCOD-48 provisions the key, with no further edit here.
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    await $`bun ./packages/desktop/scripts/finalize-latest-json.ts`
  } else {
    console.log("skipping desktop updater signatures (TAURI_SIGNING_PRIVATE_KEY is not set)")
  }
  // Unsigned: this one only rewrites electron-updater's latest.yml metadata, so it runs regardless.
  await $`bun ./packages/desktop/scripts/finalize-latest-yml.ts`
}

if (Script.release && !Script.preview) {
  await $`git commit -am "release: ${tag}"`
  await $`git tag -d ${tag}`.nothrow()
  await $`git tag ${tag}`
  await $`git push origin refs/tags/${tag} --force-with-lease --no-verify`
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await $`git fetch origin`
  await $`git checkout -B dev origin/dev`
  await prepareReleaseFiles()
  await $`git commit -am "sync release versions for ${tag}"`
  await $`git push origin HEAD:dev --no-verify`
}

if (Script.release) {
  await $`gh release edit ${tag} --draft=false --repo ${process.env.GH_REPO}`
}
