import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Audit } from "@opencode-ai/core/audit"
import { ExternalPolicy } from "../../src/external/policy"
import { ExternalDetect } from "../../src/external/detect"

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "lunos-external-"))
const events = async (file: string) => {
  await Audit.flush()
  const text = await fs.readFile(file, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("ExternalPolicy.check (XCOD-204)", () => {
  test("no policy: both tools may start", () => {
    expect(() => ExternalPolicy.check("claude", {})).not.toThrow()
    expect(() => ExternalPolicy.check("codex", {})).not.toThrow()
  })

  test("an EU-only residency policy refuses both, and the audit log records the refusal", async () => {
    const dir = await tmp()
    const auditPath = path.join(dir, "audit.log")
    const config = { residency: { allow: ["eu"] as const, auditPath } }
    expect(() => ExternalPolicy.check("claude", config)).toThrow(/Anthropic.*allows only: eu/)
    expect(() => ExternalPolicy.check("codex", config)).toThrow(/OpenAI/)
    const lines = await events(auditPath)
    expect(lines.map((line) => [line.event, line.tool, line.provider, line.reason])).toEqual([
      ["external.denied", "claude", "anthropic", "residency"],
      ["external.denied", "codex", "openai", "residency"],
    ])
  })

  test("a policy that allows the vendor's region lets it start", () => {
    expect(() => ExternalPolicy.check("claude", { residency: { allow: ["eu", "us"] as const } })).not.toThrow()
  })

  test("audit-only mode refuses nothing", () => {
    expect(() => ExternalPolicy.check("claude", { audit: { enabled: true } })).not.toThrow()
  })

  test("external.enabled false refuses, and says so when the organisation locked it", () => {
    expect(() => ExternalPolicy.check("claude", { external: { enabled: false } })).toThrow(/turned off \(external/)
    expect(() => ExternalPolicy.check("claude", { external: { enabled: false }, $locked: ["external"] })).toThrow(
      /organisation's policy/,
    )
  })
})

describe("ExternalDetect (XCOD-204)", () => {
  test("a missing tool gets a clear install hint, not an error", async () => {
    const status = await ExternalDetect.detect("codex", "/nonexistent/codex-binary")
    expect(status.installed).toBe(false)
    expect(status.hint).toContain("didn't run")
  })

  test("the version is the number, whichever word comes first", async () => {
    const fixtures = path.join(import.meta.dir, "fixtures")
    expect((await ExternalDetect.detect("codex", path.join(fixtures, "fake-codex.ts"))).version).toBe("0.160.1")
    expect((await ExternalDetect.detect("claude", path.join(fixtures, "fake-claude.ts"))).version).toMatch(
      /^\d+\.\d+\.\d+$/,
    )
  })

  test("scripts run with Bun, and a Windows .cmd shim through a shell", () => {
    expect(ExternalDetect.command("/x/fake.ts", ["--version"])).toEqual({
      file: process.execPath,
      args: ["/x/fake.ts", "--version"],
      shell: false,
    })
    expect(ExternalDetect.command("/usr/bin/claude", ["-p"]).shell).toBe(false)
  })

  test("the tool's environment drops what a parent Claude Code session injects", () => {
    const env = ExternalDetect.environment({
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PID: "9",
      HOME: "/h",
    })
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" })
  })
})
