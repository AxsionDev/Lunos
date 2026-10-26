#!/usr/bin/env bun

// XCOD-198: the marketplace maintainer agent's fact layer. For every entry in marketplace.json it
// collects facts from the npm registry and GitHub, checks them against docs/marketplace-review.md,
// and proposes a verdict. It never edits marketplace.json and never marks an entry verified: a
// named person does that in a pull request (criteria 3–6 still need a human).
//
//   bun script/marketplace-check.ts [--out marketplace-reviews] [--only name,name]
//
// Writes <out>/<date>.json (machine-readable) and <out>/<date>.md (summary). Uses GITHUB_TOKEN for
// the GitHub API when set. No model and no other secrets: the optional judgement step is separate
// (script/marketplace-judge.ts).

import path from "path"
import fs from "fs/promises"

export const AGENT_VERSION = "0.1.0"
const root = path.resolve(import.meta.dir, "..")

type Entry = {
  name: string
  source?: { type: "npm"; package: string; version?: string } | { type: "github"; repo: string; ref?: string }
  type?: "local" | "remote"
  command?: string[]
  url?: string
  license?: string
  integrity?: string
  egress?: string[]
  review?: { status: "verified" | "community"; reviewer?: string; reviewed_version?: string }
}

export type Severity = "fail" | "warn" | "info"
export type Finding = { severity: Severity; criterion: string; message: string }
export type Verdict = "keep" | "keep-with-warning" | "needs-human-review" | "delist"

export type Report = {
  kind: "plugin" | "skill" | "hook" | "mcp"
  name: string
  status: string
  facts: Record<string, unknown>
  findings: Finding[]
  verdict: Verdict
}

// --- pure checks (unit-tested) ---------------------------------------------------------------------

/** Copyleft licences: listable (OSI-approved) but users should know. */
const COPYLEFT = /(^|[^A-Z])(A?GPL|LGPL|MPL|EPL|EUPL|OSL|CDDL)/i
/** Not OSI-approved: fails listing criterion 1. */
const NOT_OSI = /(SSPL|BUSL|PolyForm|Commons-Clause|Elastic|SUL-|CC-BY-NC|UNLICENSED|proprietary)/i

/** GitHub reports "AGPL-3.0" for an "-or-later" licence; compare the licence family and version only. */
const family = (id: string) => id.toLowerCase().replace(/-(only|or-later)$|\+$/, "")

export function licenceFindings(declared: string | undefined, upstream: string | undefined): Finding[] {
  const out: Finding[] = []
  if (!declared) out.push({ severity: "fail", criterion: "1", message: "no SPDX licence in the manifest" })
  else if (NOT_OSI.test(declared))
    out.push({ severity: "fail", criterion: "1", message: `${declared} is not OSI-approved` })
  else if (COPYLEFT.test(declared))
    out.push({
      severity: "warn",
      criterion: "1",
      message: `${declared} is OSI-approved copyleft: disclose it to users`,
    })
  if (upstream && declared && family(upstream) !== family(declared) && !NOT_OSI.test(upstream))
    out.push({
      severity: "warn",
      criterion: "1",
      message: `manifest says ${declared}, the source now says ${upstream}`,
    })
  if (upstream && NOT_OSI.test(upstream))
    out.push({ severity: "fail", criterion: "1", message: `the source is now licensed ${upstream} (not OSI-approved)` })
  return out
}

const YEAR = 365 * 24 * 3600 * 1000

export function repoFindings(
  repo: { archived?: boolean; pushed_at?: string } | undefined,
  now = Date.now(),
): Finding[] {
  if (!repo) return [{ severity: "warn", criterion: "2", message: "no public source repository found" }]
  const out: Finding[] = []
  if (repo.archived)
    out.push({ severity: "warn", criterion: "3", message: "the repository is archived (no active maintainer)" })
  if (repo.pushed_at && now - Date.parse(repo.pushed_at) > YEAR)
    out.push({
      severity: "warn",
      criterion: "3",
      message: `no commits since ${repo.pushed_at.slice(0, 10)} (over 12 months)`,
    })
  return out
}

export function scriptFindings(scripts: Record<string, string> | undefined): Finding[] {
  return ["preinstall", "install", "postinstall"]
    .filter((name) => scripts?.[name])
    .map((name) => ({
      severity: "warn" as const,
      criterion: "6",
      message: `runs a ${name} script on install: \`${scripts![name]}\` (read it before verifying)`,
    }))
}

/** The pinned package of an MCP server command, or undefined if it isn't pinned. */
export function mcpPin(command: string[] | undefined): { runner: string; spec: string; pinned: boolean } | undefined {
  if (!command?.length) return undefined
  const [runner, ...args] = command
  const spec = args.find((arg) => !arg.startsWith("-") && arg !== "run")
  if (!spec) return { runner, spec: "", pinned: false }
  if (runner === "npx") return { runner, spec, pinned: /^(@[^/]+\/)?[^@]+@\d[\w.+-]*$/.test(spec) }
  if (runner === "uvx") return { runner, spec, pinned: /==\d/.test(spec) }
  if (runner === "docker") {
    const image = args.filter((arg) => !arg.startsWith("-")).find((arg) => arg.includes("/") || arg.includes("@"))
    return { runner, spec: image ?? spec, pinned: Boolean(image && /@sha256:[0-9a-f]{64}$/.test(image)) }
  }
  return { runner, spec, pinned: false }
}

export function verdict(findings: Finding[]): Verdict {
  if (findings.some((item) => item.severity === "fail" && item.criterion === "1")) return "delist"
  if (findings.some((item) => item.severity === "fail")) return "needs-human-review"
  if (findings.some((item) => item.criterion === "6")) return "needs-human-review"
  if (findings.some((item) => item.severity === "warn")) return "keep-with-warning"
  return "keep"
}

// --- fetching -------------------------------------------------------------------------------------

async function json(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) return undefined
  return response.json() as Promise<any>
}

const github = (repo: string) =>
  json(`https://api.github.com/repos/${repo}`, {
    Accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  })

/** owner/name from a repository field or URL. */
export function githubRepo(value: unknown): string | undefined {
  const url = typeof value === "string" ? value : (value as { url?: string } | undefined)?.url
  const match = url?.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#]|$)/)
  return match ? `${match[1]}/${match[2]}` : undefined
}

async function checkNpm(entry: Entry, pkg: string, version: string | undefined) {
  const meta = await json(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}`)
  if (!meta)
    return {
      facts: { package: pkg },
      findings: [{ severity: "fail", criterion: "2", message: `${pkg} is not on npm` }] as Finding[],
    }
  const pinned = version ?? meta["dist-tags"]?.latest
  const at = meta.versions?.[pinned]
  const repo = githubRepo(at?.repository ?? meta.repository)
  const gh = repo ? await github(repo) : undefined
  const facts = {
    package: pkg,
    version: pinned,
    latest: meta["dist-tags"]?.latest,
    published: meta.time?.[pinned],
    npm_license: at?.license,
    deprecated: at?.deprecated,
    integrity_matches: entry.integrity ? entry.integrity === at?.dist?.integrity : undefined,
    install_scripts: Object.fromEntries(
      ["preinstall", "install", "postinstall"]
        .filter((name) => at?.scripts?.[name])
        .map((name) => [name, at.scripts[name]]),
    ),
    repository: repo,
    repo_archived: gh?.archived,
    repo_pushed_at: gh?.pushed_at,
    repo_license: gh?.license?.spdx_id,
  }
  const findings: Finding[] = [
    ...licenceFindings(
      entry.license,
      gh?.license?.spdx_id && gh.license.spdx_id !== "NOASSERTION" ? gh.license.spdx_id : at?.license,
    ),
    ...(repo ? repoFindings(gh) : repoFindings(undefined)),
    ...scriptFindings(at?.scripts),
  ]
  if (!at) findings.push({ severity: "fail", criterion: "7", message: `version ${pinned} is not on npm` })
  if (facts.integrity_matches === false)
    findings.push({
      severity: "fail",
      criterion: "7",
      message: "integrity doesn't match the registry's dist.integrity",
    })
  if (at?.deprecated)
    findings.push({ severity: "warn", criterion: "3", message: `deprecated on npm: ${at.deprecated}` })
  if (version && meta["dist-tags"]?.latest && meta["dist-tags"].latest !== version)
    findings.push({
      severity: "info",
      criterion: "7",
      message: `pinned ${version}; latest on npm is ${meta["dist-tags"].latest}`,
    })
  return { facts, findings }
}

async function check(kind: Report["kind"], entry: Entry): Promise<Report> {
  let facts: Record<string, unknown> = {}
  let findings: Finding[] = []
  if (entry.source?.type === "npm")
    ({ facts, findings } = await checkNpm(entry, entry.source.package, entry.source.version))
  else if (entry.source?.type === "github") {
    const gh = await github(entry.source.repo)
    facts = {
      repository: entry.source.repo,
      ref: entry.source.ref,
      repo_archived: gh?.archived,
      repo_pushed_at: gh?.pushed_at,
      repo_license: gh?.license?.spdx_id,
    }
    findings = [...licenceFindings(entry.license, gh?.license?.spdx_id), ...repoFindings(gh)]
    if (!entry.source.ref)
      findings.push({ severity: "warn", criterion: "7", message: "not pinned to a ref: installs the default branch" })
  } else if (kind === "mcp") {
    const pin = mcpPin(entry.command)
    facts = { type: entry.type, command: entry.command, url: entry.url, pin }
    findings = licenceFindings(entry.license, undefined)
    if (entry.type === "local" && !pin?.pinned)
      findings.push({
        severity: "fail",
        criterion: "7",
        message: `command isn't pinned to a version or digest: ${entry.command?.join(" ")}`,
      })
  } else {
    facts = { url: entry.url }
    findings = licenceFindings(entry.license, undefined)
  }
  // Network access is as declared; nothing here observes it.
  facts.egress = entry.egress ? { declared: entry.egress, verified: false } : { declared: null, verified: false }
  if (!entry.egress)
    findings.push({
      severity: "info",
      criterion: "5",
      message: "no egress declared (needed before it can be verified)",
    })
  return {
    kind,
    name: entry.name,
    status: entry.review?.status ?? "unreviewed",
    facts,
    findings,
    verdict: verdict(findings),
  }
}

// --- report ---------------------------------------------------------------------------------------

const KINDS = { plugins: "plugin", skills: "skill", hooks: "hook", mcp: "mcp" } as const

export function markdown(reports: Report[], date: string) {
  const counts = Object.entries(Object.groupBy(reports, (item) => item.verdict)).map(
    ([key, items]) => `${key} ${items!.length}`,
  )
  const lines = [
    `# Marketplace check, ${date}`,
    "",
    `Agent ${AGENT_VERSION} (script/marketplace-check.ts) checked ${reports.length} entries against docs/marketplace-review.md: ${counts.join(", ")}.`,
    "These are facts from the npm registry and GitHub and a proposed verdict. Nothing is verified by this report: a named person approves any change in a pull request. Network access is listed as declared, not observed.",
    "",
    "| Entry | Kind | Status | Proposed | Findings |",
    "| --- | --- | --- | --- | --- |",
    ...reports.map((item) =>
      [
        `\`${item.name}\``,
        item.kind,
        item.status,
        `**${item.verdict}**`,
        item.findings
          .filter((finding) => finding.severity !== "info")
          .map((finding) => `${finding.severity} (${finding.criterion}): ${finding.message}`)
          .join("<br>") || "none",
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .concat(" |"),
    ),
  ]
  return lines.join("\n") + "\n"
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const out = path.resolve(root, args.includes("--out") ? args[args.indexOf("--out") + 1] : "marketplace-reviews")
  const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : undefined
  const manifest = await Bun.file(path.join(root, "marketplace.json")).json()
  const reports: Report[] = []
  for (const [key, kind] of Object.entries(KINDS))
    for (const entry of (manifest[key] ?? []) as Entry[])
      if (!only || only.has(entry.name)) reports.push(await check(kind, entry))
  const date = new Date().toISOString().slice(0, 10)
  await fs.mkdir(out, { recursive: true })
  await Bun.write(
    path.join(out, `${date}.json`),
    JSON.stringify({ agent: AGENT_VERSION, date, reports }, null, 2) + "\n",
  )
  await Bun.write(path.join(out, `${date}.md`), markdown(reports, date))
  console.log(markdown(reports, date))
}
