import { describe, expect, test } from "bun:test"
import path from "path"
import {
  badge,
  isPublishWorkflow,
  lag,
  newFailures,
  ownedHits,
  parseFailures,
  parseOwned,
  prBody,
  redFlags,
  upstreamPRs,
  withTests,
  resolveVersionLines,
  type Body,
} from "./upstream-sync"

const DAY = 24 * 60 * 60
const NOW = 1_790_000_000

describe("upstream sync", () => {
  test("lag is the age of the oldest missing upstream commit", () => {
    expect(lag([NOW - 2 * DAY, NOW - 9 * DAY - 60, NOW - DAY], NOW, "abc")).toEqual({
      commits: 3,
      days: 9,
      oldest: "abc",
    })
  })

  test("no missing commits means no lag", () => {
    expect(lag([], NOW)).toEqual({ commits: 0, days: 0 })
    expect(badge(lag([], NOW))).toMatchObject({ message: "up to date", color: "brightgreen" })
  })

  test("badge colour follows the 7 and 14 day targets", () => {
    expect(badge({ commits: 5, days: 7 }).color).toBe("brightgreen")
    expect(badge({ commits: 5, days: 8 })).toMatchObject({ color: "yellow", message: "8 days (5 commits)" })
    expect(badge({ commits: 5, days: 15 }).color).toBe("red")
    expect(badge({ commits: 1, days: 1 }).message).toBe("1 day (1 commits)")
  })

  test("reads the owned-paths file, skipping comments and blanks", () => {
    expect(parseOwned("# header\n\n.github/workflows/**\n  docs/**  \n# x\n")).toEqual([
      ".github/workflows/**",
      "docs/**",
    ])
  })

  test("the checked-in owned-paths list covers the areas XCOD-118 names", async () => {
    const globs = parseOwned(await Bun.file(path.join(import.meta.dir, "../.github/lunos-owned-paths")).text())
    const files = [
      ".github/workflows/publish.yml",
      "packages/opencode/src/installation/index.ts",
      "packages/opencode/src/provider/provider.ts",
      "packages/opencode/src/share/share-next.ts",
      "packages/opencode/script/publish.ts",
      "packages/opencode/src/marketplace/index.ts",
      "README.md",
    ]
    expect(ownedHits(files, globs)).toEqual(files)
    expect(ownedHits(["packages/opencode/src/session/prompt.ts", "packages/web/README.md"], globs)).toEqual([])
  })

  test("flags workflow and action changes, and singles out release workflows", () => {
    expect(redFlags(["a.ts", ".github/workflows/triage.yml", ".github/actions/setup-bun/action.yml"])).toEqual([
      ".github/workflows/triage.yml",
      ".github/actions/setup-bun/action.yml",
    ])
    expect(isPublishWorkflow(".github/workflows/publish.yml")).toBe(true)
    expect(isPublishWorkflow(".github/workflows/publish-vscode.yml")).toBe(true)
    expect(isPublishWorkflow(".github/workflows/release-github-action.yml")).toBe(true)
    expect(isPublishWorkflow(".github/workflows/test.yml")).toBe(false)
  })

  test("collects upstream PR numbers from squash subjects", () => {
    expect(upstreamPRs(["abc fix: a (#51538)", "def feat: b (#49718)", "ghi chore: no pr", "jkl x (#49718)"])).toEqual([
      49718, 51538,
    ])
  })

  test("parses bun failures from a CI log and diffs them against the baseline", () => {
    const log = [
      "2026-09-26T14:40:01.1Z (pass) config > loads [1.20ms]",
      "2026-09-26T14:40:01.2Z (fail) session > compacts long history [12.00ms]",
      "2026-09-26T14:40:01.3Z (fail) tool > bash times out",
      "2026-09-26T14:40:01.4Z (fail) session > compacts long history [11.00ms]",
    ].join("\n")
    const branch = parseFailures(log)
    expect(branch).toEqual(["session > compacts long history", "tool > bash times out"])
    expect(newFailures(branch, ["tool > bash times out"])).toEqual(["session > compacts long history"])
  })

  const base: Body = {
    status: "clean",
    branch: "upstream-sync/2026-09-27",
    upstreamSha: "b471c2b4495747353af768fbf2e0790c9d820ce2",
    before: { commits: 63, days: 8 },
    after: { commits: 0, days: 0 },
    commits: ["b471c2b449 fix: x (#51538)"],
    prs: [51538],
    changed: ["packages/opencode/src/session/prompt.ts", ".github/workflows/publish.yml"],
    owned: [".github/workflows/publish.yml"],
    conflicts: [],
  }

  test("a clean PR body reports lag, PRs, red flags and owned paths", () => {
    const body = prBody(base)
    expect(body).toContain("**Before:** 8 days behind upstream (63 commits)")
    expect(body).toContain("**After merging:** up to date with upstream")
    expect(body).toContain("https://github.com/anomalyco/opencode/pull/51538")
    expect(body).toContain("🔴 **`.github/workflows/publish.yml` (release workflow)**")
    expect(body).toContain("## Lunos-owned paths touched by upstream")
    expect(body).not.toContain("Merge conflicts")
  })

  test("a conflicting PR body lists the files and never claims a merge", () => {
    const body = prBody({ ...base, status: "conflict", conflicts: ["bun.lock", "packages/core/package.json"] })
    expect(body).toContain("## ⚠️ Merge conflicts")
    expect(body).toContain("- `bun.lock`\n- `packages/core/package.json`")
    expect(body).toContain("git checkout upstream-sync/2026-09-27 && git merge origin/dev")
    expect(body).toContain("bun script/upstream-sync.ts stamp --upstream b471c2b4495747353af768fbf2e0790c9d820ce2")
  })

  test("the tests section can be replaced in place", () => {
    const body = withTests(prBody(base), "- ✅ No new failures")
    expect(body).toContain("<!-- upstream-sync:tests -->\n- ✅ No new failures\n<!-- /upstream-sync:tests -->")
    expect(body).not.toContain("Waiting for")
  })

  test("keeps Lunos's version where the version line is the only conflict", () => {
    const text = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.18.40",',
      "=======",
      '  "version": "1.18.33",',
      ">>>>>>> upstream/dev",
      '  "name": "@opencode-ai/core",',
      "}",
    ].join("\n")
    expect(resolveVersionLines(text)).toEqual({
      text: ["{", '  "version": "1.18.40",', '  "name": "@opencode-ai/core",', "}"].join("\n"),
      resolved: 1,
      remaining: 0,
    })
  })

  test("leaves any other conflict for a person, including a version hunk with more in it", () => {
    const other = ["<<<<<<< HEAD", '  "open": "10.1.2",', "=======", '  "open": "11.0.4",', ">>>>>>> upstream/dev"]
    const mixed = [
      "<<<<<<< HEAD",
      '  "version": "1.18.40",',
      '  "name": "lunos",',
      "=======",
      '  "version": "1.18.33",',
      '  "name": "opencode",',
      ">>>>>>> upstream/dev",
    ]
    const version = [
      "<<<<<<< HEAD",
      '  "version": "1.18.40",',
      "=======",
      '  "version": "1.18.33",',
      ">>>>>>> upstream/dev",
    ]
    const result = resolveVersionLines(["{", ...version, ...other, ...mixed, "}"].join("\n"))
    expect(result.resolved).toBe(1)
    expect(result.remaining).toBe(2)
    expect(result.text).toContain('"open": "10.1.2"')
    expect(result.text).toContain("<<<<<<< HEAD")
    // The version-only hunk is settled; the mixed hunk keeps both sides for a person.
    expect(result.text.split('"version": "1.18.33"').length - 1).toBe(1)
    expect(result.text).toContain('"name": "opencode"')
  })

  test("the PR body says which files kept Lunos's version", () => {
    expect(prBody({ ...base, versionsKept: ["packages/core/package.json"] })).toContain(
      "## Version lines kept automatically",
    )
    expect(prBody(base)).not.toContain("Version lines kept")
  })
})
