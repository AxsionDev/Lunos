export * as SecurityReview from "./review"

import { AuditLog } from "@/audit/log"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { SecurityDeps } from "./deps"
import { SecurityRules } from "./rules"
import { SecurityTarget } from "./target"

/**
 * The deterministic half of the security review (XCOD-334): pattern and entropy checks over the
 * added lines, the anti-forgery check over the files they sit in, and OSV for dependency bumps.
 * `lunos security-review` gates on it; `/security-review` gives it to the model as the starting
 * point for its own review and fixes.
 */

export type Suppressed = SecurityRules.Finding & { reason: string }

export type Report = {
  target: string
  files: number
  findings: SecurityRules.Finding[]
  suppressed: Suppressed[]
  /** `lunos-ignore-security` comments with no reason: they suppress nothing. */
  unjustified: { file: string; line: number }[]
  dependencies: SecurityDeps.Result
  /** The project's own rules from `.lunos/security.md` at the base revision. */
  rules?: string
}

export type Options = {
  cwd: string
  spec: SecurityTarget.Spec
  /** Look changed dependencies up in OSV (default on; always off in offline mode). */
  osv?: boolean
  lookup?: SecurityDeps.Lookup
}

export const MARKER = "lunos-ignore-security"
const SUPPRESSION = new RegExp(String.raw`(?:\/\/|#|\/\*|<!--|--|')\s*${MARKER}\b(.*)$`)

export async function run(options: Options): Promise<Report> {
  const target = await SecurityTarget.resolve(options.cwd, options.spec)
  const live = target.changes.filter((change) => !change.deleted)
  const scanned = await Promise.all(
    live.map(async (change) => {
      const content = await target.after(change.file)
      return {
        content,
        findings: [
          ...SecurityRules.scanLines(change.file, change.added),
          ...SecurityRules.scanFile(
            change.file,
            [...change.added, ...(change.removed ?? []).map((line) => ({ line }))],
            content,
          ),
        ],
      }
    }),
  )
  const dependencies = await SecurityDeps.check(target, { enabled: options.osv !== false, lookup: options.lookup })
  const contents = new Map(live.map((change, index) => [change.file, scanned[index]!.content]))
  const all = [...scanned.flatMap((item) => item.findings), ...dependencies.findings]

  const findings: SecurityRules.Finding[] = []
  const suppressed: Suppressed[] = []
  const unjustified = new Map<string, { file: string; line: number }>()
  for (const item of all) {
    const marker = suppression(contents.get(item.file), item.line)
    if (marker?.reason) {
      suppressed.push({ ...item, reason: marker.reason })
      continue
    }
    if (marker) unjustified.set(`${item.file}:${marker.line}`, { file: item.file, line: marker.line })
    findings.push(item)
  }
  // Every honoured suppression is audited, so an ignored finding is never silent.
  const ignored = sort(suppressed)
  for (const item of ignored)
    AuditLog.emit("security.suppressed", {
      rule: item.id,
      cwe: item.cwe,
      severity: item.severity,
      paths: [item.file],
      line: item.line,
      reason: item.reason,
      target: target.label,
    })

  return {
    target: target.label,
    files: live.length,
    findings: sort(findings),
    suppressed: ignored,
    unjustified: [...unjustified.values()],
    dependencies,
    rules: (await target.rules())?.trim() || undefined,
  }
}

/** `lunos-ignore-security <reason>` on the finding's line, or alone on the line above it. */
export function suppression(content: string | undefined, line: number) {
  if (!content) return undefined
  const lines = content.split("\n")
  const same = SUPPRESSION.exec(lines[line - 1] ?? "")
  const above = lines[line - 2] ?? ""
  const prior = /^\s*(?:\/\/|#|\/\*|<!--|--|')/.test(above) ? SUPPRESSION.exec(above) : null
  const match = same ?? prior
  if (!match) return undefined
  const reason = match[1]!
    .replace(/\*\/|-->/g, "")
    .replace(/^[\s:-]+/, "")
    .trim()
  return { reason, line: same ? line : line - 1 }
}

function sort<T extends SecurityRules.Finding>(items: T[]) {
  return items.toSorted(
    (a, b) =>
      SecurityRules.rank(a.severity) - SecurityRules.rank(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  )
}

/** Unsuppressed findings at or above `threshold` (High by default): the CI gate. */
export function blocking(report: Report, threshold: SecurityRules.Severity = "high") {
  return report.findings.filter((item) => SecurityRules.atLeast(item.severity, threshold))
}

export function counts(findings: readonly SecurityRules.Finding[]) {
  return Object.fromEntries(
    SecurityRules.SEVERITIES.map((severity) => [
      severity,
      findings.filter((item) => item.severity === severity).length,
    ]),
  ) as Record<SecurityRules.Severity, number>
}

const LABEL: Record<SecurityRules.Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
}

/** The human-readable report, Markdown so it reads the same in a terminal and in the session. */
export function markdown(report: Report) {
  const total = counts(report.findings)
  const lines = [
    `## Security review: ${report.target}`,
    "",
    `${report.files} changed file(s). Findings: ${SecurityRules.SEVERITIES.map((severity) => `${total[severity]} ${LABEL[severity]}`).join(", ")}.${report.suppressed.length ? ` ${report.suppressed.length} suppressed.` : ""}`,
    "",
  ]
  for (const item of report.findings)
    lines.push(
      `### [${LABEL[item.severity]}] ${item.title} (${item.cwe})`,
      `\`${item.file}:${item.line}\` · rule \`${item.id}\``,
      "",
      `    ${item.snippet}`,
      "",
      `- **Why it matters:** ${item.why}`,
      `- **Fix:** ${item.fix}`,
      ...(item.detail ? [`- **Advisories:** ${item.detail}`] : []),
      "",
    )
  if (!report.findings.length) lines.push("No findings.", "")
  const deps = report.dependencies
  if (deps.bumps.length) {
    lines.push(`### Dependency changes (${deps.bumps.length})`, "")
    for (const bump of deps.bumps)
      lines.push(
        `- ${bump.ecosystem} \`${bump.name}\` ${bump.from ?? "(new)"} -> ${bump.to} (\`${bump.file}:${bump.line}\`)`,
      )
    lines.push("", OSV_NOTE[deps.osv] + (deps.error ? ` ${deps.error}` : ""), "")
  }
  if (report.suppressed.length) {
    lines.push("### Suppressed (recorded in the audit log)", "")
    for (const item of report.suppressed)
      lines.push(`- [${LABEL[item.severity]}] ${item.title} at \`${item.file}:${item.line}\`: "${item.reason}"`)
    lines.push("")
  }
  for (const item of report.unjustified)
    lines.push(`Note: \`${MARKER}\` at \`${item.file}:${item.line}\` has no reason, so it suppresses nothing.`)
  return lines.join("\n").trimEnd() + "\n"
}

const OSV_NOTE: Record<SecurityDeps.Result["osv"], string> = {
  checked: "Checked against OSV (api.osv.dev).",
  disabled: "Not checked against OSV (--no-osv).",
  offline: "Not checked against OSV: offline mode (LUNOS_OFFLINE) is on.",
  failed: "The OSV lookup failed, so these were not checked:",
}

const SECURITY_SEVERITY: Record<SecurityRules.Severity, string> = {
  critical: "9.5",
  high: "8.0",
  medium: "5.5",
  low: "2.0",
}
const LEVEL: Record<SecurityRules.Severity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
}

/**
 * SARIF 2.1.0 for GitHub, GitLab and Azure DevOps code scanning. Suppressed findings are results
 * with an in-source suppression, so the scanner shows them as dismissed rather than losing them.
 */
export function sarif(report: Report) {
  const all = [...report.findings, ...report.suppressed]
  const rules = [...new Map(all.map((item) => [item.id, item])).values()]
  const index = new Map(rules.map((rule, position) => [rule.id, position]))
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0" as const,
    runs: [
      {
        tool: {
          driver: {
            name: "Lunos security-review",
            informationUri: "https://lunos.tech",
            semanticVersion: /^\d+\.\d+\.\d+/.test(InstallationVersion) ? InstallationVersion : undefined,
            rules: rules.map((rule) => ({
              id: rule.id,
              name: rule.id.replace(/[^A-Za-z0-9]+(.)/g, (_, char: string) => char.toUpperCase()),
              shortDescription: { text: rule.title },
              fullDescription: { text: rule.why },
              help: { text: rule.fix, markdown: `**Fix:** ${rule.fix}` },
              defaultConfiguration: { level: LEVEL[rule.severity] },
              properties: {
                tags: ["security", rule.category, `external/cwe/${rule.cwe.toLowerCase()}`],
                "security-severity": SECURITY_SEVERITY[rule.severity],
                precision: "medium",
              },
            })),
          },
        },
        originalUriBaseIds: { "%SRCROOT%": { description: { text: "The repository root" } } },
        results: all.map((item) => ({
          ruleId: item.id,
          ruleIndex: index.get(item.id)!,
          level: LEVEL[item.severity],
          message: { text: `${item.title} (${item.cwe}). ${item.why}${item.detail ? ` ${item.detail}` : ""}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: item.file.replaceAll("\\", "/"), uriBaseId: "%SRCROOT%" },
                region: { startLine: Math.max(1, item.line) },
              },
            },
          ],
          partialFingerprints: { "lunosFinding/v1": `${item.id}:${item.file}:${item.snippet}` },
          properties: { severity: item.severity, cwe: item.cwe },
          ...("reason" in item ? { suppressions: [{ kind: "inSource" as const, justification: item.reason }] } : {}),
        })),
      },
    ],
  }
}

/**
 * `/security-review`'s template with the scan's results and the base branch's rules filled in. A
 * scan that can't run (not a git repository, no `gh`) is reported to the model, not thrown: it can
 * still review the diff itself.
 */
export async function expand(template: string, args: string, cwd: string) {
  const report = await run({ cwd, spec: SecurityTarget.parse(args) }).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  )
  const scan = report instanceof Error ? `The deterministic scan could not run: ${report.message}` : forModel(report)
  const rules =
    report instanceof Error || !report.rules
      ? `(none: no ${SecurityTarget.RULES_FILE} on the base branch)`
      : report.rules
  // Function replacements: the scan's text can hold `$&` and friends.
  return template.replace("$SECURITY_SCAN", () => scan).replace("$SECURITY_RULES", () => rules)
}

/** What `/security-review` and the `security_scan` tool give the model: the report plus the raw findings. */
export function forModel(report: Report) {
  return [
    markdown(report),
    "```json",
    JSON.stringify(
      {
        target: report.target,
        findings: report.findings.map(({ why: _why, ...rest }) => rest),
        suppressed: report.suppressed.map((item) => ({
          id: item.id,
          file: item.file,
          line: item.line,
          reason: item.reason,
        })),
        dependencies: report.dependencies.bumps,
        osv: report.dependencies.osv,
      },
      null,
      2,
    ),
    "```",
  ].join("\n")
}
