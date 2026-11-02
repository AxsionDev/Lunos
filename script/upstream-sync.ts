#!/usr/bin/env bun

// XCOD-118: keeps Lunos current with upstream opencode, following XCOD-16's merge-not-rebase
// policy. Used by .github/workflows/upstream-sync.yml; also runs locally for a dry look.
//
// Lunos tracks upstream's v1 *release tags* (v1.19.0, ...), not upstream `dev`: on 2026-10-11
// upstream promoted v2 to `dev` (5caf1f9f6f), and merging that is a v2 migration, evaluated in a
// separate spike. Upstream keeps releasing v1 from its own line. Tags are fetched into
// refs/upstream-tags/*, never refs/tags/*, because Lunos's own release tags are v1.x too.
//
//   bun script/upstream-sync.ts latest-tag [--remote upstream]   (newest upstream vMAJOR.MINOR.PATCH v1 tag)
//   bun script/upstream-sync.ts measure [--base origin/dev] [--upstream refs/upstream-tags/v1.19.0]
//   bun script/upstream-sync.ts merge --branch upstream-sync/v1.19.0 --upstream refs/upstream-tags/v1.19.0 [--base ...] [--name v1.19.0]
//   bun script/upstream-sync.ts stamp --upstream <ref>   (after resolving a conflicting sync by hand)
//   bun script/upstream-sync.ts report --pr <n> --run <test run id> --baseline <dev test run id> [--typecheck <run id>]
//
// "Days behind upstream" is the age of the oldest upstream commit that isn't in the base branch.
// `merge` never resolves conflicts and never force-pushes: on a conflict it leaves the branch at
// the upstream tip, so the PR shows GitHub's conflict banner, and lists the files to resolve.

import { $ } from "bun"
import path from "path"

const root = path.resolve(import.meta.dir, "..")
const OWNED_FILE = path.join(root, ".github/lunos-owned-paths")
const PACKAGE_FILE = path.join(root, "packages/opencode/package.json")
const UPSTREAM_REPO = "anomalyco/opencode"
const DAY = 24 * 60 * 60
/** Where upstream release tags are fetched to, so they can't clash with Lunos's own `v1.x` tags. */
export const TAG_NAMESPACE = "refs/upstream-tags"
/** The upstream major version Lunos follows (see the header). */
const TRACKED_MAJOR = 1

/** `v1.19.0` -> [1, 19, 0]; anything else (pre-releases, `github-v1.0.0`, `v2.x`, `0.0.47`) is undefined. */
export function releaseVersion(tag: string, major = TRACKED_MAJOR) {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/)
  if (!match || Number(match[1]) !== major) return
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const
}

/** Tag names from `git ls-remote --tags` output, without `refs/tags/` and the peeled `^{}` lines. */
export function parseRemoteTags(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref): ref is string => !!ref && ref.startsWith("refs/tags/") && !ref.endsWith("^{}"))
    .map((ref) => ref.slice("refs/tags/".length))
}

/** The newest stable v1 release tag, by version number (so v1.10.0 beats v1.9.0). */
export function latestReleaseTag(tags: string[], major = TRACKED_MAJOR) {
  let best: { tag: string; version: readonly number[] } | undefined
  for (const tag of tags) {
    const version = releaseVersion(tag, major)
    if (!version) continue
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version }
  }
  return best?.tag
}

function compareVersions(a: readonly number[], b: readonly number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

export type Lag = { commits: number; days: number; oldest?: string }

/** Lag from the committer times (unix seconds) of upstream commits missing from the base branch. */
export function lag(times: number[], now: number, oldest?: string): Lag {
  if (!times.length) return { commits: 0, days: 0 }
  const min = Math.min(...times)
  return { commits: times.length, days: Math.max(0, Math.floor((now - min) / DAY)), oldest }
}

/** Globs from .github/lunos-owned-paths. */
export function parseOwned(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
}

/** Changed files that fall under a Lunos-owned glob. */
export function ownedHits(files: string[], globs: string[]) {
  const matchers = globs.map((glob) => new Bun.Glob(glob))
  return files.filter((file) => matchers.some((m) => m.match(file)))
}

/** Upstream changes to CI or release plumbing. Publish workflows are the loudest. */
export function redFlags(files: string[]) {
  return files.filter((file) => file.startsWith(".github/workflows/") || file.startsWith(".github/actions/"))
}

export function isPublishWorkflow(file: string) {
  return /^\.github\/workflows\/(publish|release)[^/]*\.ya?ml$/.test(file)
}

/** Upstream PR numbers from squash-merge subjects like "fix: thing (#1234)". */
export function upstreamPRs(subjects: string[]) {
  const found = subjects.flatMap((s) => [...s.matchAll(/\(#(\d+)\)/g)].map((m) => Number(m[1])))
  return [...new Set(found)].sort((a, b) => a - b)
}

/** Test names bun reported as failing, from a job log. */
export function parseFailures(log: string) {
  const found = log
    .split("\n")
    .map((line) => line.match(/\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/)?.[1])
    .filter((name): name is string => !!name)
  return [...new Set(found)].sort()
}

export function newFailures(branch: string[], baseline: string[]) {
  const known = new Set(baseline)
  return branch.filter((name) => !known.has(name))
}

/** shields.io endpoint JSON for the README badge. */
export function badge(value: Lag) {
  const color = value.days <= 7 ? "brightgreen" : value.days <= 14 ? "yellow" : "red"
  const message = value.commits === 0 ? "up to date" : `${days(value.days)} (${value.commits} commits)`
  return { schemaVersion: 1, label: "behind upstream", message, color }
}

function days(n: number) {
  return `${n} ${n === 1 ? "day" : "days"}`
}

export function describeLag(value: Lag) {
  if (value.commits === 0) return "up to date with upstream"
  return `${days(value.days)} behind upstream (${value.commits} commits)`
}

export type Body = {
  status: "clean" | "conflict"
  /** What was merged, as people know it: an upstream release tag (`v1.19.0`) or branch. */
  upstreamName?: string
  /** package.json files whose only conflicts were the version line, settled to Lunos's version. */
  versionsKept?: string[]
  branch: string
  upstreamSha: string
  before: Lag
  after: Lag
  commits: string[]
  prs: number[]
  changed: string[]
  owned: string[]
  conflicts: string[]
}

function describeUpstream(name = "dev") {
  return releaseVersion(name)
    ? `\`${UPSTREAM_REPO}\` release tag [\`${name}\`](https://github.com/${UPSTREAM_REPO}/releases/tag/${name})`
    : `\`${UPSTREAM_REPO}\` \`${name}\``
}

export function prBody(input: Body) {
  const repo = `https://github.com/${UPSTREAM_REPO}`
  const flags = redFlags(input.changed)
  const lines = [
    `Automated merge of ${describeUpstream(input.upstreamName)} @ [\`${input.upstreamSha.slice(0, 10)}\`](${repo}/commit/${input.upstreamSha}) (XCOD-118).`,
    "",
    ...(releaseVersion(input.upstreamName ?? "")
      ? [`Lunos follows upstream's v1 release tags: upstream \`dev\` is now v2, which is evaluated separately.`, ""]
      : []),
    `- **Before:** ${describeLag(input.before)}.`,
    `- **After merging:** ${describeLag(input.after)}.`,
    `- **Upstream commits:** ${input.commits.length}`,
    `- **Upstream PRs:** ${input.prs.length ? input.prs.map((n) => `${repo}/pull/${n}`).join(", ") : "none referenced"}`,
    "",
  ]
  if (input.status === "conflict") {
    lines.push(
      "## ⚠️ Merge conflicts",
      "",
      "This branch is the upstream tip, not a merge: the workflow never resolves conflicts. Resolve it",
      "with a normal merge commit (never squash or rebase, or upstream drops out of `dev`'s history):",
      "",
      "```sh",
      `git fetch origin && git checkout ${input.branch} && git merge origin/dev`,
      "# fix the files below, then record the upstream base and lag this build will report:",
      `bun script/upstream-version.ts --upstream ${input.upstreamSha} && bun script/upstream-sync.ts stamp --upstream ${input.upstreamSha}`,
      "git add -A && git commit --no-edit && git push",
      "```",
      "",
      ...input.conflicts.map((file) => `- \`${file}\``),
      "",
    )
  }
  if (flags.length) {
    lines.push(
      "## 🔴 Upstream changed CI or release plumbing",
      "",
      "Check each of these before merging: the fork's workflows differ from upstream on purpose.",
      "",
      ...flags.map((file) =>
        isPublishWorkflow(file) ? `- 🔴 **\`${file}\` (release workflow)**` : `- 🔴 \`${file}\``,
      ),
      "",
    )
  }
  if (input.versionsKept?.length) {
    lines.push(
      "## Version lines kept automatically",
      "",
      `Only the \`"version"\` line conflicted in ${input.versionsKept.length} package.json files; the workflow kept Lunos's version in each (the one conflict it resolves by itself). Everything else in those files merged normally.`,
      "",
    )
  }
  lines.push("## Lunos-owned paths touched by upstream", "")
  if (input.owned.length) {
    lines.push(
      "Upstream changed files that Lunos has modified on purpose (`.github/lunos-owned-paths`). Review these by hand, even if the merge is clean.",
      "",
      ...input.owned.map((file) => `- \`${file}\``),
    )
  } else lines.push("None.")
  lines.push(
    "",
    "**Merge with a merge commit**, not squash or rebase: otherwise the upstream commits never reach `dev` and the lag doesn't fall.",
    "",
    "## Tests",
    "",
    "<!-- upstream-sync:tests -->",
    "_Waiting for the `test` and `typecheck` runs on this branch._",
    "<!-- /upstream-sync:tests -->",
    "",
    `<details><summary>Upstream commits (${input.commits.length})</summary>`,
    "",
    ...input.commits.map((line) => `- ${line}`),
    "",
    "</details>",
  )
  return lines.join("\n")
}

/** Replaces the tests section of an existing PR body. */
export function withTests(body: string, section: string) {
  return body.replace(
    /<!-- upstream-sync:tests -->[\s\S]*?<!-- \/upstream-sync:tests -->/,
    `<!-- upstream-sync:tests -->\n${section}\n<!-- /upstream-sync:tests -->`,
  )
}

/** A conflict hunk whose sides are each only a `"version": "…"` line. */
const VERSION_LINE = /^\s*"version":\s*"[^"]*",?\s*$/

/**
 * Resolves the conflict hunks in a package.json that are only the `"version"` line, keeping
 * Lunos's side (Petar, 2026-09-27: both projects bump every package's version on each release, so
 * these lines conflict on nearly every sync). Any other hunk is left exactly as it was.
 * `remaining` counts the hunks still needing a person.
 */
export function resolveVersionLines(text: string) {
  const lines = text.split("\n")
  const out: string[] = []
  let resolved = 0
  let remaining = 0
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("<<<<<<< ")) {
      out.push(lines[i])
      continue
    }
    const middle = lines.findIndex((line, j) => j > i && line.startsWith("======="))
    const end = lines.findIndex((line, j) => j > middle && line.startsWith(">>>>>>> "))
    if (middle === -1 || end === -1) {
      out.push(...lines.slice(i))
      remaining++
      break
    }
    const ours = lines.slice(i + 1, middle)
    const theirs = lines.slice(middle + 1, end)
    if (ours.length === 1 && theirs.length === 1 && VERSION_LINE.test(ours[0]) && VERSION_LINE.test(theirs[0])) {
      out.push(ours[0])
      resolved++
    } else {
      out.push(...lines.slice(i, end + 1))
      remaining++
    }
    i = end
  }
  return { text: out.join("\n"), resolved, remaining }
}

function flag(args: string[], name: string, fallback?: string) {
  const index = args.indexOf(`--${name}`)
  const value = index === -1 ? fallback : args[index + 1]
  if (value === undefined) throw new Error(`upstream-sync: missing --${name}`)
  return value
}

async function git(...args: string[]) {
  return (await $`git ${args}`.cwd(root).quiet()).stdout.toString().trim()
}

async function measure(base: string, upstream: string) {
  // First-parent: upstream squash-merges, so its first-parent committer dates are the merge times.
  const out = await git("log", "--first-parent", "--format=%H %ct", `${base}..${upstream}`)
  const rows = out ? out.split("\n").map((line) => line.split(" ")) : []
  const oldest = rows.reduce<string[] | undefined>((a, b) => (!a || Number(b[1]) < Number(a[1]) ? b : a), undefined)
  return lag(
    rows.map((row) => Number(row[1])),
    Math.floor(Date.now() / 1000),
    oldest?.[0],
  )
}

/** Records the upstream base and lag in packages/opencode/package.json, for `--version --verbose`. */
async function stamp(upstream: string) {
  const sha = await git("rev-parse", `${upstream}^{commit}`)
  const value = await measure("HEAD", upstream)
  const text = await Bun.file(PACKAGE_FILE).text()
  const pkg = JSON.parse(text)
  pkg.lunos = {
    ...pkg.lunos,
    upstreamSync: {
      commit: sha,
      measuredAt: new Date().toISOString().slice(0, 10),
      daysBehind: value.days,
      commitsBehind: value.commits,
    },
  }
  await Bun.write(PACKAGE_FILE, JSON.stringify(pkg, null, 2) + "\n")
}

async function merge(args: string[]) {
  const base = flag(args, "base", "origin/dev")
  const upstream = flag(args, "upstream")
  const name = flag(args, "name", upstream.replace(/^refs\/upstream-tags\//, ""))
  const branch = flag(args, "branch")
  const out = flag(args, "out", path.join(root, ".upstream-sync"))

  // ^{commit}: a tag ref names the annotated tag object, not the commit it marks.
  const sha = await git("rev-parse", `${upstream}^{commit}`)
  const before = await measure(base, upstream)
  const commits = (await git("log", "--format=%h %s", "--first-parent", `${base}..${upstream}`))
    .split("\n")
    .filter(Boolean)
  const mergeBase = await git("merge-base", base, upstream)
  const changed = (await git("diff", "--name-only", mergeBase, upstream)).split("\n").filter(Boolean)
  const owned = ownedHits(changed, parseOwned(await Bun.file(OWNED_FILE).text()))

  await git("checkout", "-B", branch, base)
  const result =
    await $`git merge --no-ff --no-edit -m ${`Merge ${UPSTREAM_REPO} ${name} into Lunos (${branch})`} ${upstream}`
      .cwd(root)
      .quiet()
      .nothrow()
  let status: Body["status"] = "clean"
  let conflicts: string[] = []
  const versionsKept: string[] = []
  if (result.exitCode !== 0) {
    conflicts = (await git("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean)
    if (!conflicts.length) throw new Error(`upstream-sync: merge failed without conflicts\n${result.stderr}`)
    // Settle version-only conflicts in package.json files; anything else stays for a person.
    for (const file of conflicts.filter((file) => file.endsWith("package.json"))) {
      const full = path.join(root, file)
      const fixed = resolveVersionLines(await Bun.file(full).text())
      if (fixed.resolved > 0 && fixed.remaining === 0) {
        await Bun.write(full, fixed.text)
        await git("add", file)
        versionsKept.push(file)
      }
    }
    conflicts = conflicts.filter((file) => !versionsKept.includes(file))
    if (conflicts.length) {
      status = "conflict"
      await git("merge", "--abort")
      await git("checkout", "-B", branch, upstream)
    } else {
      await git("commit", "--no-edit")
    }
  }
  if (status === "clean" && before.commits) {
    await $`bun ./script/upstream-version.ts --upstream ${upstream}`.cwd(root).quiet()
    await stamp(upstream)
    await git("add", PACKAGE_FILE)
    await git("commit", "-m", `chore(upstream-sync): record upstream lag after ${branch}`)
  }
  // On a conflict HEAD is the upstream tip, so this is the lag once the PR is resolved and merged.
  const after = await measure("HEAD", upstream)

  const body = prBody({
    status,
    upstreamName: name,
    branch,
    upstreamSha: sha,
    before,
    after,
    commits,
    prs: upstreamPRs(commits),
    versionsKept,
    changed,
    owned,
    conflicts,
  })
  await $`mkdir -p ${out}`
  await Bun.write(path.join(out, "body.md"), body)
  const summary = {
    status,
    upstreamName: name,
    upstreamSha: sha,
    before: { ...before, text: describeLag(before) },
    after: { ...after, text: describeLag(after) },
    owned,
    conflicts,
    redFlags: redFlags(changed),
  }
  await Bun.write(path.join(out, "result.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

async function jobFailures(run: string) {
  const repo = process.env.GITHUB_REPOSITORY ?? "AxsionDev/Lunos"
  const jobs = JSON.parse(
    (await $`gh api ${`repos/${repo}/actions/runs/${run}/jobs?per_page=100`}`.quiet()).stdout.toString(),
  ).jobs as { id: number; name: string; conclusion: string }[]
  const failed = jobs.filter((job) => job.conclusion === "failure")
  const names = await Promise.all(
    failed.map(async (job) => {
      const log = await $`gh api ${`repos/${repo}/actions/jobs/${job.id}/logs`}`.quiet().nothrow()
      return parseFailures(log.stdout.toString()).map((name) => `${job.name}: ${name}`)
    }),
  )
  return { jobs: failed.map((job) => job.name), tests: names.flat() }
}

async function report(args: string[]) {
  const pr = flag(args, "pr")
  const run = flag(args, "run")
  const baseline = flag(args, "baseline")
  const repo = process.env.GITHUB_REPOSITORY ?? "AxsionDev/Lunos"
  const branch = await jobFailures(run)
  const base = await jobFailures(baseline)
  const fresh = newFailures(branch.tests, base.tests)
  const link = (id: string) => `https://github.com/${repo}/actions/runs/${id}`
  const lines = [
    `- [\`test\` run on this branch](${link(run)}): ${branch.tests.length} failing tests; [\`dev\` baseline](${link(baseline)}): ${base.tests.length}.`,
    fresh.length
      ? `- 🔴 **New failures against the \`dev\` baseline (${fresh.length}):**`
      : "- ✅ No new failures against the `dev` baseline.",
    ...fresh.map((name) => `  - \`${name}\``),
  ]
  const typecheck = flag(args, "typecheck", "")
  if (typecheck) {
    const run = JSON.parse((await $`gh api ${`repos/${repo}/actions/runs/${typecheck}`}`.quiet()).stdout.toString())
    lines.unshift(`- [\`typecheck\` run on this branch](${link(typecheck)}): ${run.conclusion ?? run.status}`)
  }
  const unnamed = branch.jobs.filter((job) => !branch.tests.some((name) => name.startsWith(`${job}: `)))
  if (unnamed.length)
    lines.push(`- ⚠️ Failed jobs with no test names in the log (check by hand): ${unnamed.join(", ")}`)
  const section = lines.join("\n")
  console.log(section)

  const body = (await $`gh pr view ${pr} --repo ${repo} --json body --jq .body`.quiet()).stdout.toString()
  await $`gh pr edit ${pr} --repo ${repo} --body ${withTests(body, section)}`.quiet()
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "latest-tag") {
    const remote = flag(args, "remote", "upstream")
    const tag = latestReleaseTag(parseRemoteTags(await git("ls-remote", "--tags", remote, `v${TRACKED_MAJOR}.*`)))
    if (!tag) throw new Error(`upstream-sync: no v${TRACKED_MAJOR}.x.y release tag on ${remote}`)
    console.log(tag)
  } else if (command === "measure") {
    const value = await measure(flag(args, "base", "origin/dev"), flag(args, "upstream"))
    console.log(JSON.stringify({ ...value, text: describeLag(value), badge: badge(value) }))
  } else if (command === "merge") await merge(args)
  else if (command === "stamp") {
    await stamp(flag(args, "upstream"))
    console.log(JSON.stringify(JSON.parse(await Bun.file(PACKAGE_FILE).text()).lunos))
  } else if (command === "report") await report(args)
  else {
    console.error("usage: upstream-sync.ts latest-tag|measure|merge|stamp|report [options]")
    process.exit(1)
  }
}
