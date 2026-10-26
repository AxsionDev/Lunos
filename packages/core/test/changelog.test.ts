import { describe, expect, test } from "bun:test"
import { Changelog } from "../src/changelog"

const FIXTURE = `# Changelog

## [Unreleased]

- **Not released yet.** Never shown. <!-- XCOD-999 -->

## [1.2.0] - 2026-10-16

### Changed

- **Sharing is off by default.** Set \`share: "manual"\` to get it back.
  <!-- XCOD-10 -->

### Added

- **\`lunos agent run\`.** Runs an agent. <!-- XCOD-11 -->
  - **Sub item.** Stays on its own line.
- **Audit entries record \`chars\`.** For the record. <!-- XCOD-15 --> <!-- internal -->
- **\`/sessions\`.** Lists sessions. <!-- XCOD-12 --> <!-- highlight -->

### Fixed

- **Fix A.** <!-- XCOD-13 -->
- **Fix B.** <!-- XCOD-14 -->
- **CI fix.** <!-- internal -->

## [1.1.0] - 2026-10-01

### Security

- **Upgrade now.** A token could leak, wrapped
\`lazily\` onto a line of its own. <!-- XCOD-20 -->

### Fixed

- **Fix C.** <!-- XCOD-21 -->
- **Fix D.** <!-- XCOD-22 -->

## [1.0.5] - 2026-09-20

## [1.0.0] - 2026-09-01

### Added

- **First release.** <!-- XCOD-1 -->

---

Footer text that isn't a version.
`

describe("CHANGELOG summary (XCOD-248, XCOD-253)", () => {
  const all = Changelog.parse(FIXTURE)

  test("parses released versions only, with section, lead, markers and sub-items, comments stripped", () => {
    expect(all.map((v) => v.version)).toEqual(["1.2.0", "1.1.0", "1.0.5", "1.0.0"])
    const added = all[0]!.entries.filter((e) => e.section === "Added")
    expect(added[0]).toMatchObject({ lead: "`lunos agent run`.", internal: false, highlight: false })
    expect(added[1]).toMatchObject({ internal: true })
    expect(added[2]).toMatchObject({ highlight: true })
    expect(added[0]!.text).toContain("\n  - **Sub item.**")
    expect(all[0]!.entries[0]!.text).toBe('**Sharing is off by default.** Set `share: "manual"` to get it back.')
    expect(all[1]!.entries[0]!.text).toBe(
      "**Upgrade now.** A token could leak, wrapped `lazily` onto a line of its own.",
    )
    expect(all[0]!.markdown).not.toContain("<!--")
    expect(all[3]!.markdown).not.toContain("Footer")
  })

  test("a range covers every version after since, skipped ones included", () => {
    expect(Changelog.range("1.0.0", "1.2.0", all).map((v) => v.version)).toEqual(["1.2.0", "1.1.0", "1.0.5"])
  })

  test("behaviour changes and security first, highlights lead, internal entries left out; fixes are a count", () => {
    const lines = Changelog.summary({ since: "1.0.0", to: "1.2.0", all, max: 6 })
    expect(lines).toEqual([
      "What's new in Lunos 1.2.0 (since 1.0.0)",
      "No notes for 1.0.5.",
      "Changed behaviour",
      "• Sharing is off by default",
      "Security",
      "• Upgrade now",
      "New",
      "• `/sessions`",
      "• `lunos agent run`",
      "4 fixes, including: Fix A; Fix B; Fix C",
      "Full notes: https://github.com/AxsionDev/Lunos/releases/tag/v1.2.0 or lunos changelog --since 1.0.0",
    ])
  })

  test("a version missing from the CHANGELOG says there are no notes, not an error", () => {
    expect(Changelog.summary({ since: "1.2.0", to: "1.3.0", all })).toEqual([
      "What's new in Lunos 1.3.0 (since 1.2.0)",
      "No notes for 1.3.0.",
      "Full notes: https://github.com/AxsionDev/Lunos/releases/tag/v1.3.0 or lunos changelog --since 1.2.0",
    ])
  })

  test("the built-in CHANGELOG parses and has the current release", () => {
    const built = Changelog.versions()
    expect(built.length).toBeGreaterThan(5)
    expect(built.every((v) => Changelog.isVersion(v.version))).toBe(true)
    expect(Changelog.previous(built[0]!.version)).toBe(built[1]!.version)
  })

  test("no ticket id reaches a reader: every summary and the full notes of the built-in CHANGELOG", () => {
    const built = Changelog.versions()
    const oldest = built.at(-1)!.version
    for (const version of built) {
      expect(Changelog.summary({ since: oldest, to: version.version }).join("\n")).not.toMatch(/XCOD-\d+/)
      expect(
        Changelog.summary({ since: Changelog.previous(version.version), to: version.version }).join("\n"),
      ).not.toMatch(/XCOD-\d+/)
      expect(version.markdown).not.toMatch(/XCOD-\d+/)
      for (const entry of version.entries) expect(entry.text).not.toMatch(/XCOD-\d+/)
    }
  })

  test("1.18.49's summary leaves out the audit-field entry and stays short", () => {
    const lines = Changelog.summary({ since: "1.18.46", to: "1.18.49" })
    expect(lines.join("\n")).not.toContain("memory.recall")
    expect(lines.length).toBeLessThanOrEqual(16)
  })
})
