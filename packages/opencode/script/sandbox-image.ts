#!/usr/bin/env bun
// XCOD-144: build the sandbox image locally, for development or when the published image
// (ghcr.io/axsiondev/lunos:<version>) can't be pulled. Builds the Linux musl binary for the
// Docker daemon's architecture, then the image from ./Dockerfile with only that binary as the
// build context.
//
//   bun run script/sandbox-image.ts [--tag lunos-sandbox:local] [--skip-build]
//
// Then point the sandbox at it: `"sandbox": { "image": "lunos-sandbox:local" }`.
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const dir = path.resolve(import.meta.dirname, "..")
const tagIndex = process.argv.indexOf("--tag")
const tag = tagIndex > 0 ? process.argv[tagIndex + 1] : "lunos-sandbox:local"
const arch = (await $`docker info --format {{.Architecture}}`.text()).trim()
const target = arch === "aarch64" || arch === "arm64" ? "linux-arm64-musl" : "linux-x64-baseline-musl"
const dockerArch = target.includes("arm64") ? "arm64" : "amd64"

if (!process.argv.includes("--skip-build")) {
  await $`bun run script/build.ts --target=${target} --skip-embed-web-ui`.cwd(dir)
}

const context = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-image-"))
try {
  await fs.mkdir(path.join(context, "dist", `lunos-${target}`, "bin"), { recursive: true })
  await fs.copyFile(
    path.join(dir, "dist", `lunos-${target}`, "bin", "opencode"),
    path.join(context, "dist", `lunos-${target}`, "bin", "opencode"),
  )
  await fs.copyFile(path.join(dir, "Dockerfile"), path.join(context, "Dockerfile"))
  await $`docker build --platform linux/${dockerArch} -t ${tag} ${context}`
  console.log(`built ${tag}`)
} finally {
  await fs.rm(context, { recursive: true, force: true })
}
