#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"

const output = [`version=${Script.version}`]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()

if (!Script.preview) {
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`

  // script/changelog.ts shells out to `opencode run --command changelog`, an AI call against
  // upstream's hosted gateway that needs OPENCODE_API_KEY. This fork does not have one, and the
  // call fails with an opaque "Unexpected server error" that took the whole release down at the
  // very first job. Release notes are not worth blocking a release over, so degrade in stages.
  const ai = await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd()).nothrow()
  if (ai.exitCode !== 0) {
    console.warn(`changelog.ts failed (exit ${ai.exitCode}) — falling back to raw-changelog.ts`)
    // Same commit range, no AI: builds the notes from git history and the GitHub API.
    const raw = await $`bun script/raw-changelog.ts --to ${sha}`.cwd(process.cwd()).nothrow()
    if (raw.exitCode === 0) {
      await Bun.write(file, raw.stdout.toString())
    } else {
      console.warn(`raw-changelog.ts also failed (exit ${raw.exitCode}) — notes will be a placeholder`)
    }
  }

  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/opencode-release-notes.txt`
  await Bun.write(notesFile, body)
  await $`gh release create v${Script.version} -d --target ${sha} --title "v${Script.version}" --notes-file ${notesFile}`
  const release = await $`gh release view v${Script.version} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --repo ${process.env.GH_REPO}`
  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
