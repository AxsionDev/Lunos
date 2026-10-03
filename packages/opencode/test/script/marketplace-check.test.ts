import { describe, expect, test } from "bun:test"
import path from "path"
import {
  githubRepo,
  licenceFindings,
  mcpPin,
  repoFindings,
  scriptFindings,
  verdict,
} from "../../../../script/marketplace-check"

// XCOD-198: the marketplace maintainer agent's fact checks, and the human gate on `verified`.
const root = path.resolve(import.meta.dir, "../../../..")

describe("marketplace check (XCOD-198)", () => {
  test("licences: OSI copyleft warns, non-OSI and missing fail, a relicensed source is flagged", () => {
    expect(licenceFindings("MIT", "MIT")).toEqual([])
    expect(licenceFindings("AGPL-3.0-or-later", "AGPL-3.0").map((item) => item.severity)).toEqual(["warn"])
    expect(licenceFindings("SSPL-1.0", undefined)[0].severity).toBe("fail")
    expect(licenceFindings(undefined, undefined)[0].severity).toBe("fail")
    expect(licenceFindings("MIT", "BUSL-1.1").some((item) => item.severity === "fail")).toBe(true)
    expect(licenceFindings("MIT", "Apache-2.0")[0].message).toContain("the source now says Apache-2.0")
  })

  test("an archived or idle repository warns (criterion 3)", () => {
    const now = Date.parse("2026-10-03")
    expect(repoFindings({ archived: false, pushed_at: "2026-09-01T00:00:00Z" }, now)).toEqual([])
    expect(repoFindings({ archived: true, pushed_at: "2026-09-01T00:00:00Z" }, now)[0].message).toContain("archived")
    expect(repoFindings({ archived: false, pushed_at: "2025-01-01T00:00:00Z" }, now)[0].message).toContain(
      "over 12 months",
    )
  })

  test("install scripts are quoted for a person to read (criterion 6)", () => {
    expect(scriptFindings({ postinstall: "node scripts/postinstall.cjs", test: "x" })).toEqual([
      {
        severity: "warn",
        criterion: "6",
        message: "runs a postinstall script on install: `node scripts/postinstall.cjs` (read it before verifying)",
      },
    ])
  })

  test("MCP commands must be pinned to a version or digest", () => {
    expect(mcpPin(["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.8.31"])?.pinned).toBe(true)
    expect(mcpPin(["npx", "-y", "@playwright/mcp@latest"])?.pinned).toBe(false)
    expect(mcpPin(["uvx", "mcp-server-git==2026.8.18"])?.pinned).toBe(true)
    expect(mcpPin(["uvx", "mcp-server-git"])?.pinned).toBe(false)
    expect(
      mcpPin(["docker", "run", "-i", "--rm", `ghcr.io/github/github-mcp-server@sha256:${"a".repeat(64)}`])?.pinned,
    ).toBe(true)
    expect(mcpPin(["docker", "run", "-i", "ghcr.io/github/github-mcp-server:latest"])?.pinned).toBe(false)
  })

  test("verdicts: non-OSI delists, install scripts need a person, warnings keep with a warning", () => {
    expect(verdict([])).toBe("keep")
    expect(verdict([{ severity: "warn", criterion: "3", message: "" }])).toBe("keep-with-warning")
    expect(verdict([{ severity: "warn", criterion: "6", message: "" }])).toBe("needs-human-review")
    expect(verdict([{ severity: "fail", criterion: "7", message: "" }])).toBe("needs-human-review")
    expect(verdict([{ severity: "fail", criterion: "1", message: "" }])).toBe("delist")
  })

  test("repository URLs in their npm forms resolve to owner/name", () => {
    expect(githubRepo({ url: "git+https://github.com/zenobi-us/opencode-skillful.git" })).toBe(
      "zenobi-us/opencode-skillful",
    )
    expect(githubRepo("github:owner/x")).toBeUndefined()
    expect(githubRepo("https://github.com/a/b/tree/main/packages/c")).toBe("a/b")
  })
})

describe("the human gate on verified entries", () => {
  test("every verified entry names a person as reviewer, the reviewed version, and the agent version", async () => {
    const manifest = await Bun.file(path.join(root, "marketplace.json")).json()
    for (const key of ["plugins", "skills", "hooks", "mcp"])
      for (const entry of manifest[key] ?? []) {
        if (entry.review?.status !== "verified") continue
        expect(entry.review.reviewer, `${entry.name}: reviewer`).toBeTruthy()
        expect(entry.review.reviewer, `${entry.name}: reviewer must be a person`).not.toMatch(
          /bot|agent|\[|github-actions/i,
        )
        expect(entry.review.reviewed_version, `${entry.name}: reviewed_version`).toBeTruthy()
        expect(entry.review.agent_version, `${entry.name}: agent_version`).toBeTruthy()
      }
  })
})
