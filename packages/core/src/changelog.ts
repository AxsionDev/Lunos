export * as Changelog from "./changelog"

import semver from "semver"
// XCOD-248: the curated CHANGELOG, embedded at build time so "what's new" needs no network.
import CHANGELOG from "../../../CHANGELOG.md" with { type: "text" }

export type Entry = {
  version: string
  section: string
  /** The bold lead sentence, without its asterisks; the whole first line when there is none. */
  lead: string
  /** The entry as written, sub-items included. */
  text: string
  tickets: string[]
}

export type Version = { version: string; date?: string; entries: Entry[]; markdown: string }

const VERSION_HEADING = /^## \[([^\]]+)\](?:\s+-\s+(\S+))?/
const SECTION_HEADING = /^### (.+)$/

function entry(version: string, section: string, lines: string[]): Entry {
  const text = lines
    .join("\n")
    .replace(/^- /, "")
    // Wrapped lines join up; sub-items (`  - …`) keep their own line.
    .replace(/\n[ ]+(?![ ]*- )/g, " ")
    .trim()
  const lead = (text.match(/^\*\*(.+?)\*\*/)?.[1] ?? text.split("\n")[0]!).trim()
  return { version, section, lead, text, tickets: [...new Set(text.match(/XCOD-\d+/g) ?? [])] }
}

/** Every released version, newest first, with its entries. `[Unreleased]` is left out. */
export function parse(markdown: string): Version[] {
  const versions: Version[] = []
  let version: Version | undefined
  let section = ""
  let lines: string[] | undefined
  const flush = () => {
    if (version && lines) version.entries.push(entry(version.version, section, lines))
    lines = undefined
  }
  for (const line of markdown.split("\n")) {
    const heading = line.match(VERSION_HEADING)
    if (heading) {
      flush()
      version = semver.valid(heading[1])
        ? { version: heading[1]!, date: heading[2], entries: [], markdown: "" }
        : undefined
      if (version) versions.push(version)
      section = ""
      continue
    }
    if (!version) continue
    // A rule ends the release notes; what follows (link references, notes) belongs to no version.
    if (line.startsWith("---")) {
      flush()
      version = undefined
      continue
    }
    version.markdown += line + "\n"
    const sub = line.match(SECTION_HEADING)
    if (sub) {
      flush()
      section = sub[1]!.trim()
      continue
    }
    if (line.startsWith("- ")) {
      flush()
      lines = [line]
      continue
    }
    if (lines && (line.startsWith(" ") || line === "")) lines.push(line)
  }
  flush()
  for (const item of versions) item.markdown = item.markdown.trim()
  return versions
}

let cached: Version[] | undefined
export function versions() {
  return (cached ??= parse(CHANGELOG))
}

/**
 * The versions after `since` up to and including `to`, newest first, so skipped versions are in.
 * `to` gets an empty placeholder when the CHANGELOG has no section for it.
 */
export function range(since: string | undefined, to: string, all = versions()) {
  const picked = all.filter(
    (item) => (!since || !semver.valid(since) || semver.gt(item.version, since)) && semver.lte(item.version, to),
  )
  if (semver.valid(to) && !picked.some((item) => item.version === to))
    picked.unshift({ version: to, entries: [], markdown: "" })
  return picked
}

const BEHAVIOUR = ["Changed", "Removed", "Deprecated"]

export function releaseUrl(version: string) {
  return `https://github.com/AxsionDev/Lunos/releases/tag/v${version}`
}

// One line per item: entries without a bold lead start with a whole sentence, so it's cut short.
function short(text: string, max = 100) {
  const line = text.replace(/\.$/, "")
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line
}

function item(entry: Entry) {
  const lead = short(entry.lead)
  const tickets = entry.tickets.filter((ticket) => !lead.includes(ticket))
  return `• ${lead}${tickets.length ? ` (${tickets.join(", ")})` : ""}`
}

/**
 * The short, engineering-focused summary: behaviour changes first and never trimmed, then every
 * security entry, then what's new, then a one-line count of fixes. About `max` lines in all; what
 * doesn't fit is behind `lunos changelog`.
 */
export function summary(input: { since?: string; to: string; max?: number; all?: Version[] }) {
  const picked = range(input.since, input.to, input.all)
  const entries = picked.flatMap((item) => item.entries)
  const of = (sections: string[]) => entries.filter((item) => sections.includes(item.section))
  const lines: string[] = [
    input.since && input.since !== input.to
      ? `What's new in Lunos ${input.to} (since ${input.since})`
      : `What's new in Lunos ${input.to}`,
  ]
  for (const item of picked) if (!item.entries.length) lines.push(`No notes for ${item.version}.`)

  const behaviour = of(BEHAVIOUR)
  const security = of(["Security"])
  if (behaviour.length) lines.push("Changed behaviour", ...behaviour.map(item))
  if (security.length) lines.push("Security", ...security.map(item))

  const fixed = of(["Fixed"])
  const footer = [
    ...(fixed.length
      ? [
          `${fixed.length} ${fixed.length === 1 ? "fix" : "fixes"}, including: ${fixed
            .slice(0, 3)
            .map((entry) => short(entry.lead, 50))
            .join("; ")}`,
        ]
      : []),
    `Full notes: ${releaseUrl(input.to)} or lunos changelog${input.since ? ` --since ${input.since}` : ""}`,
  ]

  const added = of(["Added"])
  if (added.length) {
    // Behaviour and security entries are never trimmed, so with many of them the summary runs over
    // `max` rather than dropping what's new altogether.
    const room = Math.max(4, (input.max ?? 15) - lines.length - footer.length - 1)
    const shown = added.length > room ? added.slice(0, room - 1) : added
    lines.push("New", ...shown.map(item))
    if (shown.length < added.length) lines.push(`  and ${added.length - shown.length} more`)
  }
  return [...lines, ...footer]
}

/** Whether `version` is newer than `than`; false for anything that isn't a version. */
export function isNewer(version: string, than: string) {
  return !!semver.valid(version) && !!semver.valid(than) && semver.gt(version, than)
}

export function isVersion(version: string | undefined): version is string {
  return !!version && !!semver.valid(version)
}

/** The newest noted release before `to`. */
export function previous(to: string, all = versions()) {
  return all.find((item) => semver.valid(to) && semver.lt(item.version, to))?.version
}

/** `version` itself, or for a development build (no version) the newest release noted. */
export function current(version: string, all = versions()) {
  return semver.valid(version) ? version : all[0]?.version
}
