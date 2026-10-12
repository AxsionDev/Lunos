#!/usr/bin/env bun

// XCOD-227: v1.18.46 shipped with no CHANGELOG.md section. Two checks keep that from recurring.
//
//   bun script/check-changelog.ts [--file CHANGELOG.md] [version]
//     Release gate (publish.yml, before the step that creates the draft release). Exits 1 unless
//     CHANGELOG.md has a non-empty `## [X.Y.Z]` section for the version being released. With no
//     version argument it computes the version exactly as script/version.ts does (OPENCODE_BUMP /
//     OPENCODE_VERSION through @opencode-ai/script), and skips preview and beta builds
//     (`0.0.0-…`), which never get a section.
//
//   git diff --name-only base...head | bun script/check-changelog.ts --pr [--labels a,b]
//     Pull-request check (changelog.yml). Prints a `::warning::` when the PR changes user-facing
//     code (see userFacing) without touching CHANGELOG.md, unless it has the `no-changelog` label.
//     Always exits 0: it's a reminder, not a gate.

const HEADING = /^## \[([^\]]+)\][^\n]*$/gm

/** Every `## [X]` heading in the file, in order, with the text up to the next `## ` heading. */
export function sections(text: string) {
  const heads = [...text.matchAll(HEADING)]
  return heads.map((match, i) => {
    const start = match.index! + match[0].length
    const rest = text.slice(start, i + 1 < heads.length ? heads[i + 1].index : undefined)
    const end = rest.search(/^## /m)
    return { name: match[1], body: (end === -1 ? rest : rest.slice(0, end)).trim() }
  })
}

export function normalize(version: string) {
  return version.trim().replace(/^v/, "")
}

/** Previews (`0.0.0-dev-…`) and betas (`0.0.0-beta-…`) are never in the changelog. */
export function isPreview(version: string) {
  return normalize(version).startsWith("0.0.0-")
}

export function checkRelease(text: string, version: string): { ok: true } | { ok: false; message: string } {
  const want = normalize(version)
  const found = sections(text).find((s) => s.name === want)
  const fix = `Add a "## [${want}] - YYYY-MM-DD" section to CHANGELOG.md on dev (move the shipped lines out of [Unreleased]), then dispatch the release again.`
  if (!found) {
    const latest = sections(text).find((s) => s.name !== "Unreleased")?.name ?? "none"
    return {
      ok: false,
      message: `CHANGELOG.md has no section for ${want} (latest released section: ${latest}). ${fix}`,
    }
  }
  if (!found.body) return { ok: false, message: `CHANGELOG.md's section for ${want} is empty. ${fix}` }
  return { ok: true }
}

const TEST = /(\.test\.|\.spec\.|\/test\/|\/tests\/|\/__tests__\/|\/fixtures?\/|\.snap$)/

/**
 * "User-facing code" for the PR check: source under a package's `src/` directory
 * (`packages/<pkg>/src/…`, `packages/<group>/<pkg>/src/…`), minus tests, fixtures and snapshots.
 * Docs, scripts, workflows and config are left out on purpose: they get a changelog line when they
 * change what a user sees, which is a judgement the reviewer makes, not this check.
 */
export function userFacing(file: string) {
  return /^packages\/(?:[^/]+\/)?[^/]+\/src\//.test(file) && !TEST.test(file)
}

export function checkPR(
  files: string[],
  labels: string[],
): { warn: false; reason: string } | { warn: true; files: string[] } {
  if (labels.includes("no-changelog")) return { warn: false, reason: "label no-changelog" }
  if (files.includes("CHANGELOG.md")) return { warn: false, reason: "CHANGELOG.md changed" }
  const code = files.filter(userFacing)
  if (code.length === 0) return { warn: false, reason: "no user-facing code changed" }
  return { warn: true, files: code }
}

function flag(args: string[], name: string) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)

  if (args.includes("--pr")) {
    args.splice(args.indexOf("--pr"), 1)
    const labels = (flag(args, "--labels") ?? process.env.PR_LABELS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
    const files = (await Bun.stdin.text())
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
    const result = checkPR(files, labels)
    if (!result.warn) {
      console.log(`changelog: ok (${result.reason})`)
    } else {
      const shown = result.files.slice(0, 10).join(", ") + (result.files.length > 10 ? ", …" : "")
      console.log(
        `::warning title=No CHANGELOG.md line::This PR changes user-facing code (${shown}) but not CHANGELOG.md. Add a line under [Unreleased] (user benefit first, ticket key in brackets), or add the no-changelog label if users won't notice the change.`,
      )
    }
    process.exit(0)
  }

  const file = flag(args, "--file") ?? "CHANGELOG.md"
  const version = await (async () => {
    if (args[0]) return args[0]
    // Same computation as script/version.ts. Imported lazily: its top level checks the Bun version
    // and asks the npm registry for lunos-ai's latest version.
    const { Script } = await import("@opencode-ai/script")
    return Script.preview ? `0.0.0-${Script.channel}` : Script.version
  })()

  if (isPreview(version)) {
    console.log(`changelog: skipped for preview build ${version}`)
    process.exit(0)
  }

  const text = await Bun.file(file)
    .text()
    .catch(() => undefined)
  if (text === undefined) {
    console.error(`::error::${file} not found`)
    process.exit(1)
  }
  const result = checkRelease(text, version)
  if (!result.ok) {
    console.error(`::error title=Missing changelog section::${result.message}`)
    process.exit(1)
  }
  console.log(`changelog: ${file} has a section for ${normalize(version)}`)
}
