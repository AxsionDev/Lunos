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

  // XCOD-294: what the installed tool says about its sign-in (fakes replaying 2.1.304 / 0.160.1 in a fresh HOME).
  test("signed out is what the tool's own status says, and the hint is its own login command", async () => {
    const fixtures = path.join(import.meta.dir, "fixtures")
    const dir = await tmp()
    const before = { claude: process.env.FAKE_CLAUDE_AUTH, codex: process.env.FAKE_CODEX_AUTH }
    process.env.FAKE_CLAUDE_AUTH = path.join(dir, "claude")
    process.env.FAKE_CODEX_AUTH = path.join(dir, "codex")
    try {
      const claude = await ExternalDetect.detect("claude", path.join(fixtures, "fake-claude.ts"))
      expect(claude).toMatchObject({ installed: true, loggedIn: false, authMethod: "none" })
      expect(claude.hint).toContain("`claude auth login`")
      const codex = await ExternalDetect.detect("codex", path.join(fixtures, "fake-codex.ts"))
      expect(codex).toMatchObject({ installed: true, loggedIn: false })
      expect(codex.hint).toContain("`codex login`")
      // Signed in once the tool's own login has run (its file, which Lunos never reads).
      await fs.writeFile(path.join(dir, "claude"), "x")
      await fs.writeFile(path.join(dir, "codex"), "x")
      expect((await ExternalDetect.detect("claude", path.join(fixtures, "fake-claude.ts"))).loggedIn).toBe(true)
      expect((await ExternalDetect.detect("codex", path.join(fixtures, "fake-codex.ts"))).loggedIn).toBe(true)
    } finally {
      for (const [key, value] of [
        ["FAKE_CLAUDE_AUTH", before.claude],
        ["FAKE_CODEX_AUTH", before.codex],
      ] as const)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      await fs.rm(dir, { recursive: true, force: true })
    }
    expect(ExternalDetect.LOGIN).toEqual({ claude: ["auth", "login"], codex: ["login"] })
  })

  test("Codex failing to load its config isn't 'signed out': logging in wouldn't fix it", () => {
    expect(ExternalDetect.codexLoggedIn({ code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" })).toBe(true)
    expect(ExternalDetect.codexLoggedIn({ code: 1, stdout: "", stderr: "Not logged in\n" })).toBe(false)
    expect(
      ExternalDetect.codexLoggedIn({
        code: 1,
        stdout: "",
        stderr: 'Error loading configuration: CODEX_HOME points to "/x", but that path does not exist\n',
      }),
    ).toBeUndefined()
    expect(ExternalDetect.codexLoggedIn({ code: null, stdout: "", stderr: "" })).toBeUndefined()
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

describe("ExternalPolicy.evaluate (XCOD-250)", () => {
  test("says why without auditing: /claude and /codex ask it just to grey themselves out", async () => {
    const dir = await tmp()
    const auditPath = path.join(dir, "audit.log")
    const config = { residency: { allow: ["eu"] as const, auditPath } }
    expect(ExternalPolicy.evaluate("claude", config)).toMatchObject({ reason: "residency" })
    expect(ExternalPolicy.evaluate("codex", { external: { enabled: false } })).toMatchObject({ reason: "disabled" })
    expect(
      ExternalPolicy.evaluate("codex", { external: { enabled: false }, $locked: ["external.enabled"] }),
    ).toMatchObject({ reason: "policy" })
    expect(ExternalPolicy.evaluate("claude", {})).toBeUndefined()
    expect(await events(auditPath)).toEqual([])
  })
})
