export * as SecurityDeps from "./deps"

import path from "path"
import { Offline } from "@opencode-ai/core/offline"
import { SecurityRules } from "./rules"
import type { SecurityTarget } from "./target"

/**
 * Dependency changes (XCOD-334): which packages a change adds or moves to a new version, read from
 * the manifests and lockfiles it touches, then looked up in OSV (api.osv.dev). The lookup is the
 * only outbound call the review makes: off in offline mode and with `--no-osv`.
 */

export type Ecosystem = "npm" | "PyPI" | "Go" | "NuGet" | "crates.io" | "RubyGems"

export type Bump = {
  ecosystem: Ecosystem
  name: string
  from?: string
  to: string
  file: string
  line: number
}

export const OSV_URL = "https://api.osv.dev/v1/query"

/** Every package whose version is new in the change, across the manifests and lockfiles it touches. */
export async function bumps(target: SecurityTarget.Resolved): Promise<Bump[]> {
  const found = await Promise.all(
    target.changes
      .filter((change) => !change.deleted && kind(change.file))
      .map(async (change) => {
        const [after, before] = await Promise.all([target.after(change.file), target.before(change.file)])
        if (after === undefined) return []
        const now = versions(change.file, after)
        const was = before === undefined ? new Map<string, string>() : versions(change.file, before)
        return [...now.entries()]
          .filter(([name, version]) => was.get(name) !== version)
          .map(([name, version]) => ({
            ecosystem: kind(change.file)!,
            name,
            from: was.get(name),
            to: version,
            file: change.file,
            line: lineOf(after, name, version),
          }))
      }),
  )
  // A bump in both package.json and its lockfile is one bump: the lockfile's exact version wins.
  const lock = (file: string) => /lock|shrinkwrap|\.sum$/i.test(path.basename(file))
  const seen = new Map<string, Bump>()
  for (const bump of found.flat().toSorted((a, b) => Number(lock(b.file)) - Number(lock(a.file)))) {
    const key = `${bump.ecosystem}:${bump.name}`
    if (!seen.has(key)) seen.set(key, bump)
  }
  return [...seen.values()]
}

function kind(file: string): Ecosystem | undefined {
  const name = path.basename(file)
  if (["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock"].includes(name)) return "npm"
  if (/^requirements.*\.txt$/.test(name)) return "PyPI"
  if (name === "go.mod") return "Go"
  if (/\.(cs|fs|vb)proj$/.test(name) || name === "packages.config" || name === "Directory.Packages.props")
    return "NuGet"
  if (name === "Cargo.lock") return "crates.io"
  if (name === "Gemfile.lock") return "RubyGems"
}

/** Package name to its (minimum) version in one manifest or lockfile. */
export function versions(file: string, text: string): Map<string, string> {
  const name = path.basename(file)
  const out = new Map<string, string>()
  if (name === "package.json") {
    const json = parseJson(text) as Record<string, Record<string, string> | undefined> | undefined
    for (const block of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])
      for (const [pkg, range] of Object.entries(json?.[block] ?? {})) {
        const version = /\d+\.\d+\.\d+[\w.+-]*/.exec(range)?.[0]
        if (version && !/^(workspace|file|link|git|https?):/.test(range)) out.set(pkg, version)
      }
    return out
  }
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
    const json = parseJson(text) as { packages?: Record<string, { version?: string }> } | undefined
    for (const [key, value] of Object.entries(json?.packages ?? {})) {
      const pkg = key.split("node_modules/").at(-1)
      if (key && pkg && value.version) out.set(pkg, value.version)
    }
    return out
  }
  const patterns: Record<string, RegExp> = {
    "bun.lock": /^\s*"[^"]+":\s*\[\s*"((?:@[^@"/]+\/)?[^@"]+)@(\d[^"]*)"/gm,
    "go.mod": /^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v(\d[^\s/]*)/gm,
    "Cargo.lock": /^name = "([^"]+)"\nversion = "([^"]+)"/gm,
    "Gemfile.lock": /^ {4}([\w.-]+) \((\d[^)]*)\)$/gm,
  }
  const pattern =
    patterns[name] ??
    (/^requirements.*\.txt$/.test(name)
      ? /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:==|>=|~=)\s*([\w.+-]+)/gm
      : /<Package(?:Reference|Version)\s+Include="([^"]+)"\s+Version="([^"]+)"|<package\s+id="([^"]+)"\s+version="([^"]+)"/g)
  for (const match of text.matchAll(pattern)) {
    const pkg = match[1] ?? match[3]
    const version = match[2] ?? match[4]
    if (pkg && version) out.set(pkg, version)
  }
  return out
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function lineOf(text: string, name: string, version: string) {
  const lines = text.split("\n")
  const exact = lines.findIndex((line) => line.includes(name) && line.includes(version))
  if (exact >= 0) return exact + 1
  const loose = lines.findIndex((line) => line.includes(`"${name}"`) || line.includes(name))
  return loose >= 0 ? loose + 1 : 1
}

type OsvVuln = {
  id: string
  summary?: string
  aliases?: string[]
  severity?: { type: string; score: string }[]
  database_specific?: { severity?: string; cwe_ids?: string[] }
  affected?: {
    package?: { name?: string; ecosystem?: string }
    ranges?: { events?: { introduced?: string; fixed?: string }[] }[]
    database_specific?: { severity?: string }
  }[]
}

export type Lookup = (bump: Bump) => Promise<OsvVuln[]>

export function osv(fetcher: typeof fetch = fetch): Lookup {
  return async (bump) => {
    const response = await fetcher(OSV_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: { name: bump.name, ecosystem: bump.ecosystem }, version: bump.to }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`OSV answered ${response.status} for ${bump.name}@${bump.to}`)
    return ((await response.json()) as { vulns?: OsvVuln[] }).vulns ?? []
  }
}

export type Result = {
  findings: SecurityRules.Finding[]
  bumps: Bump[]
  osv: "checked" | "offline" | "disabled" | "failed"
  error?: string
}

/** One finding per vulnerable bump, at the most severe advisory's severity. */
export async function check(
  target: SecurityTarget.Resolved,
  input: { lookup?: Lookup; enabled: boolean },
): Promise<Result> {
  const changed = await bumps(target)
  if (!changed.length) return { findings: [], bumps: changed, osv: "checked" }
  if (!input.enabled) return { findings: [], bumps: changed, osv: "disabled" }
  if (Offline.enabled()) return { findings: [], bumps: changed, osv: "offline" }
  const lookup = input.lookup ?? osv()
  try {
    const results = await Promise.all(changed.map(async (bump) => ({ bump, vulns: await lookup(bump) })))
    const findings = results
      .filter((result) => result.vulns.length)
      .map((result) => {
        const ranked = result.vulns
          .map((vuln) => ({ vuln, severity: severity(vuln) }))
          .toSorted((a, b) => SecurityRules.rank(a.severity) - SecurityRules.rank(b.severity))
        const top = ranked[0]!
        const fixed = fixedVersion(result.vulns, result.bump)
        const ids = ranked.map((item) =>
          [item.vuln.id, ...(item.vuln.aliases ?? []).filter((alias) => alias.startsWith("CVE-"))].join("/"),
        )
        return SecurityRules.finding(
          {
            id: "dependency/known-vulnerability",
            title: `${result.bump.name}@${result.bump.to} has known vulnerabilities`,
            category: "dependency",
            severity: top.severity,
            cwe: top.vuln.database_specific?.cwe_ids?.[0] ?? "CWE-1395",
            why: `${top.vuln.id}${top.vuln.summary ? `: ${top.vuln.summary}` : ""}. The change ${result.bump.from ? `moves ${result.bump.name} from ${result.bump.from} to` : "adds"} ${result.bump.to}, an affected version.`,
            fix: fixed
              ? `Use ${result.bump.name} ${fixed} or later.`
              : `Use a version not affected by ${top.vuln.id}, or drop the dependency.`,
          },
          result.bump.file,
          { line: result.bump.line, text: `${result.bump.name} ${result.bump.from ?? "(new)"} -> ${result.bump.to}` },
          `${result.bump.ecosystem} ${result.bump.name} ${result.bump.from ?? "(new)"} -> ${result.bump.to}: ${ids.join(", ")}`,
        )
      })
    return { findings, bumps: changed, osv: "checked" }
  } catch (error) {
    return {
      findings: [],
      bumps: changed,
      osv: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** The advisory's own rating (GHSA's), else the CVSS v3 base score, else medium. */
export function severity(vuln: OsvVuln): SecurityRules.Severity {
  const label = (
    vuln.database_specific?.severity ??
    vuln.affected?.find((item) => item.database_specific?.severity)?.database_specific?.severity
  )?.toUpperCase()
  if (label === "CRITICAL") return "critical"
  if (label === "HIGH") return "high"
  if (label === "MODERATE" || label === "MEDIUM") return "medium"
  if (label === "LOW") return "low"
  const vector = vuln.severity?.find((item) => item.type === "CVSS_V3" || item.type === "CVSS_V4")?.score
  const score = vector ? cvss3(vector) : undefined
  if (score === undefined) return "medium"
  if (score >= 9) return "critical"
  if (score >= 7) return "high"
  if (score >= 4) return "medium"
  return "low"
}

function fixedVersion(vulns: OsvVuln[], bump: Bump) {
  const fixes = vulns.flatMap((vuln) =>
    (vuln.affected ?? [])
      .filter((item) => !item.package?.name || item.package.name === bump.name)
      .flatMap((item) => (item.ranges ?? []).flatMap((range) => (range.events ?? []).map((event) => event.fixed)))
      .filter((fixed): fixed is string => !!fixed),
  )
  // The highest fix covers every advisory listed.
  return fixes.toSorted((a, b) => Bun.semver.order(coerce(a), coerce(b))).at(-1)
}

function coerce(version: string) {
  return /\d+(\.\d+){0,2}/.exec(version)?.[0] ?? "0.0.0"
}

/** CVSS 3.x base score from a vector string (FIRST CVSS v3.1 specification, section 7.1). */
export function cvss3(vector: string): number | undefined {
  const metrics = Object.fromEntries(vector.split("/").map((part) => part.split(":") as [string, string]))
  if (!vector.startsWith("CVSS:3")) return undefined
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.AV!]
  const ac = { L: 0.77, H: 0.44 }[metrics.AC!]
  const ui = { N: 0.85, R: 0.62 }[metrics.UI!]
  const changed = metrics.S === "C"
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[metrics.PR!]
  const cia = (value?: string) => ({ H: 0.56, L: 0.22, N: 0 })[value ?? ""]
  const [c, i, a] = [cia(metrics.C), cia(metrics.I), cia(metrics.A)]
  if ([av, ac, ui, pr, c, i, a].some((value) => value === undefined)) return undefined
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!)
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss
  if (impact <= 0) return 0
  const exploitability = 8.22 * av! * ac! * pr! * ui!
  const roundUp = (value: number) => Math.ceil(value * 10 - 1e-9) / 10
  return roundUp(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10))
}
