#!/usr/bin/env bun

// XCOD-261: lunos.tech/changelog was kept by hand and fell four releases behind CHANGELOG.md. This
// check fails when the site doesn't list the latest release.
//
//   bun script/changelog-drift.ts [--url URL] [--expected X.Y.Z] [--published-at ISO] [--grace MIN]
//     Exits 1 when the site's newest version is older than the expected one, 0 when it's current
//     (or ahead, with a warning), and 2 when the page can't be read or lists no versions.
//     --expected defaults to the newest released section of CHANGELOG.md. The scheduled workflow
//     (changelog-drift.yml) passes the latest published GitHub release instead: dev gets a section
//     before its release exists, so dev's CHANGELOG.md runs ahead of every release window.
//     With --published-at, a site that is behind for less than --grace minutes (default 60) after
//     the release only warns: the site needs time to rebuild.

import { normalize, sections } from "./check-changelog"

export const DEFAULT_URL = "https://lunos.tech/changelog"

/** A version as the site links it: `…/releases/tag/vX.Y.Z`. Other version numbers in the text don't count. */
const TAG_LINK = /releases\/tag\/v(\d+\.\d+\.\d+)\b/g

export function compare(a: string, b: string) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number))
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return (x![i] ?? 0) - (y![i] ?? 0)
  return 0
}

/** The newest version the page links to a release tag, or undefined if it links none. */
export function newestOnSite(html: string) {
  return [...html.matchAll(TAG_LINK)]
    .map((m) => m[1]!)
    .sort(compare)
    .at(-1)
}

/** The newest released `## [X.Y.Z]` section of CHANGELOG.md. */
export function newestInChangelog(text: string) {
  return sections(text).find((s) => /^\d+\.\d+\.\d+$/.test(s.name ?? ""))?.name
}

export type Result =
  | { status: "current" | "ahead" | "behind" | "grace"; site: string; expected: string }
  | { status: "error"; message: string }

export async function check(input: {
  url: string
  expected: string
  publishedAt?: string
  graceMinutes?: number
  now?: number
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}): Promise<Result> {
  const get = input.fetch ?? fetch
  const expected = normalize(input.expected)
  const response = await get(input.url, { redirect: "follow", signal: AbortSignal.timeout(30_000) }).catch(
    (error: unknown) => error as Error,
  )
  if (response instanceof Error) return { status: "error", message: `${input.url}: ${response.message}` }
  if (!response.ok) return { status: "error", message: `${input.url}: HTTP ${response.status}` }
  const site = newestOnSite(await response.text())
  if (!site) return { status: "error", message: `${input.url} links no release tags (vX.Y.Z); has the page changed?` }
  const diff = compare(site, expected)
  if (diff === 0) return { status: "current", site, expected }
  if (diff > 0) return { status: "ahead", site, expected }
  if (input.publishedAt) {
    const age = (input.now ?? Date.now()) - Date.parse(input.publishedAt)
    if (age < (input.graceMinutes ?? 60) * 60_000) return { status: "grace", site, expected }
  }
  return { status: "behind", site, expected }
}

function flag(args: string[], name: string) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const url = flag(args, "--url") ?? DEFAULT_URL
  const expected =
    flag(args, "--expected") ||
    newestInChangelog(
      await Bun.file(flag(args, "--file") ?? "CHANGELOG.md")
        .text()
        .catch(() => ""),
    )
  if (!expected) {
    console.error("::error::no --expected version and no released section in CHANGELOG.md")
    process.exit(2)
  }
  const result = await check({
    url,
    expected,
    publishedAt: flag(args, "--published-at") || undefined,
    graceMinutes: Number(flag(args, "--grace") ?? 60),
  })
  switch (result.status) {
    case "error":
      console.error(`::error title=Changelog drift check failed::${result.message}`)
      process.exit(2)
    case "behind":
      console.error(
        `::error title=lunos.tech changelog is behind::${url} shows v${result.site}, the latest release is v${result.expected}.`,
      )
      process.exit(1)
    case "grace":
      console.log(
        `::warning::${url} shows v${result.site}, the latest release is v${result.expected}; it was released within the grace period, so the site may still be rebuilding.`,
      )
      break
    case "ahead":
      console.log(`::warning::${url} shows v${result.site}, newer than the expected v${result.expected}.`)
      break
    case "current":
      console.log(`changelog-drift: ${url} is current (v${result.site})`)
  }
}
