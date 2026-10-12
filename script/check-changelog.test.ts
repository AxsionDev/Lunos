import { describe, expect, test } from "bun:test"
import path from "path"
import { checkPR, checkRelease, isPreview, sections, userFacing } from "./check-changelog"

const CHANGELOG = `# Changelog

Intro text.

---

## [Unreleased]

### Added

- Something new (XCOD-1).

## [1.18.46] - 2026-10-09

### Added

- Shipped thing (XCOD-2).

## [1.18.44] - 2026-10-05

## [1.18.4] - 2026-09-01

- Old thing.

## Known limitations

- Not code-signed.

[Unreleased]: https://example.com
`

describe("release gate", () => {
  test("lists every bracketed section in order", () => {
    expect(sections(CHANGELOG).map((s) => s.name)).toEqual(["Unreleased", "1.18.46", "1.18.44", "1.18.4"])
  })

  test("a released version with a section passes, with or without a leading v", () => {
    expect(checkRelease(CHANGELOG, "1.18.46")).toEqual({ ok: true })
    expect(checkRelease(CHANGELOG, "v1.18.46")).toEqual({ ok: true })
  })

  test("a version with no section fails and names the fix", () => {
    const result = checkRelease(CHANGELOG, "9.9.9")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("no section for 9.9.9")
      expect(result.message).toContain("latest released section: 1.18.46")
      expect(result.message).toContain("## [9.9.9]")
    }
  })

  test("matches the whole version: 1.18.4 doesn't satisfy 1.18.47, nor 1.18.46 satisfy 1.18.4x", () => {
    expect(checkRelease(CHANGELOG, "1.18.47").ok).toBe(false)
    expect(checkRelease(CHANGELOG, "1.18.4").ok).toBe(true)
    expect(checkRelease(CHANGELOG, "1.18").ok).toBe(false)
  })

  test("an empty section fails", () => {
    const result = checkRelease(CHANGELOG, "1.18.44")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("is empty")
  })

  test("the last section stops at a non-version heading", () => {
    expect(sections(CHANGELOG).at(-1)?.body).toBe("- Old thing.")
  })

  test("preview and beta builds are recognised, so the gate skips them", () => {
    expect(isPreview("0.0.0-beta-202610091200")).toBe(true)
    expect(isPreview("0.0.0-dev-202610091200")).toBe(true)
    expect(isPreview("1.18.46")).toBe(false)
  })

  test("the repository's own CHANGELOG.md has a section for v1.18.46", async () => {
    const text = await Bun.file(path.resolve(import.meta.dir, "../CHANGELOG.md")).text()
    expect(checkRelease(text, "1.18.46")).toEqual({ ok: true })
  })
})

describe("pull-request check", () => {
  test("user-facing code is package source, not tests, fixtures or other files", () => {
    expect(userFacing("packages/opencode/src/cli/cmd/run.ts")).toBe(true)
    expect(userFacing("packages/console/app/src/routes/index.tsx")).toBe(true)
    expect(userFacing("packages/opencode/src/cli/cmd/run.test.ts")).toBe(false)
    expect(userFacing("packages/app/src/components/foo.spec.tsx")).toBe(false)
    expect(userFacing("packages/opencode/test/cli/run.test.ts")).toBe(false)
    expect(userFacing("packages/opencode/src/external/fixtures/codex.jsonl")).toBe(false)
    expect(userFacing("docs/models.md")).toBe(false)
    expect(userFacing("script/version.ts")).toBe(false)
    expect(userFacing(".github/workflows/publish.yml")).toBe(false)
  })

  test("source change without a changelog line warns", () => {
    expect(checkPR(["packages/opencode/src/a.ts", "README.md"], [])).toEqual({
      warn: true,
      files: ["packages/opencode/src/a.ts"],
    })
  })

  test("source change with a changelog line passes", () => {
    expect(checkPR(["packages/opencode/src/a.ts", "CHANGELOG.md"], []).warn).toBe(false)
  })

  test("test-only change passes", () => {
    expect(checkPR(["packages/opencode/test/a.test.ts", "packages/opencode/src/a.test.ts"], []).warn).toBe(false)
  })

  test("the no-changelog label skips the check", () => {
    expect(checkPR(["packages/opencode/src/a.ts"], ["bug", "no-changelog"])).toEqual({
      warn: false,
      reason: "label no-changelog",
    })
  })
})
