import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ExternalClaude } from "../../src/external/claude"
import { ExternalCodex } from "../../src/external/codex"
import { ExternalConfig } from "../../src/external/config"

// XCOD-285 acceptance: no file under ~/.claude or ~/.codex changes without a confirmed tool command or
// the user's own edit. Lunos-driven turns, including every "don't ask again" answer, run against the
// fake tools with a throwaway HOME holding a ~/.claude and ~/.codex; the files are compared before and
// after. The fake Claude Code writes a "don't ask again" into the settings file it's aimed at, as the
// real one does, so the check would see a write (the negative control below proves it does).
// Not run against the real binaries: Claude Code itself rewrites ~/.claude.json and ~/.claude/sessions/
// on every start (see test/fixtures/external/claude-2.1.292/manifest.json), with or without Lunos.

const FAKE_CLAUDE = path.join(import.meta.dir, "fixtures", "fake-claude.ts")
const FAKE_CODEX = path.join(import.meta.dir, "fixtures", "fake-codex.ts")

async function snapshot(root: string) {
  const out: Record<string, string> = {}
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else
        out[path.relative(root, full)] = createHash("sha256")
          .update(await fs.readFile(full))
          .digest("hex")
    }
  }
  await walk(root)
  return out
}

async function home() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-home-"))
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true })
  await fs.mkdir(path.join(dir, ".codex"), { recursive: true })
  await fs.writeFile(path.join(dir, ".claude", "settings.json"), '{"permissions":{"allow":[]}}\n')
  await fs.writeFile(path.join(dir, ".claude", "CLAUDE.md"), "# mine\n")
  await fs.writeFile(path.join(dir, ".claude.json"), "{}\n")
  await fs.writeFile(path.join(dir, ".codex", "config.toml"), 'model = "gpt-5.5"\n')
  await fs.writeFile(path.join(dir, ".codex", "AGENTS.md"), "# mine\n")
  return dir
}

async function withHome<T>(dir: string, env: Record<string, string>, run: () => Promise<T>) {
  const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }
  Object.assign(process.env, { HOME: dir, CODEX_HOME: path.join(dir, ".codex"), ...env })
  try {
    return await run()
  } finally {
    process.env.HOME = saved.HOME
    if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved.CODEX_HOME
    for (const key of Object.keys(env)) delete process.env[key]
  }
}

describe("~/.claude and ~/.codex are untouched by Lunos-driven turns (XCOD-285)", () => {
  test("Claude Code: Yes, don't-ask-again (aimed by the tool at user settings) and a refusal change no file", async () => {
    const dir = await home()
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-work-"))
    const before = await snapshot(dir)
    let asked = 0
    for (const answer of [
      { allow: true as const, always: true },
      { allow: true as const },
      { allow: false as const, message: "no", interrupt: true },
    ])
      await withHome(dir, { FAKE_CLAUDE_BASH: "npm test", FAKE_CLAUDE_SUGGEST: "npm test:*" }, async () => {
        const running = ExternalClaude.start({
          cwd,
          prompt: "go",
          executable: FAKE_CLAUDE,
          ask: async () => (asked++, answer),
        })
        await running.done
        await new Promise((resolve) => running.child.once("close", resolve))
      })
    expect(asked).toBe(3)
    expect(await snapshot(dir)).toEqual(before)
    // Nor the project's own .claude settings.
    expect(await snapshot(cwd)).toEqual({})
  })

  test("negative control: the same fake does write the user's settings when told to, so the check above can fail", async () => {
    const dir = await home()
    const before = await snapshot(dir)
    await withHome(dir, { FAKE_CLAUDE_BASH: "npm test", FAKE_CLAUDE_SUGGEST: "npm test:*" }, async () => {
      const child = spawn(process.execPath, [FAKE_CLAUDE, "-p"], {
        env: process.env,
        stdio: ["pipe", "pipe", "ignore"],
      })
      const write = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n")
      write({ type: "control_request", request_id: "init", request: { subtype: "initialize", hooks: null } })
      write({ type: "user", message: { role: "user", content: "go" }, parent_tool_use_id: null })
      let buffer = ""
      child.stdout.on("data", (chunk) => {
        buffer += chunk
        if (!buffer.includes('"req_bash"')) return
        buffer = ""
        // What a host that didn't keep "don't ask again" to the session would send.
        write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "req_bash",
            response: {
              behavior: "allow",
              updatedInput: {},
              updatedPermissions: [
                {
                  type: "addRules",
                  rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
                  behavior: "allow",
                  destination: "userSettings",
                },
              ],
            },
          },
        })
        setTimeout(() => child.stdin.end(), 200)
      })
      await new Promise((resolve) => child.once("close", resolve))
    })
    const after = await snapshot(dir)
    expect(after[path.join(".claude", "settings.json")]).not.toBe(before[path.join(".claude", "settings.json")])
  })

  test("Codex: approvals (once, for the session, declined) change nothing under ~/.codex", async () => {
    const dir = await home()
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-work-"))
    const before = await snapshot(dir)
    let asked = 0
    for (const answer of [
      { allow: true as const, always: true },
      { allow: true as const },
      { allow: false as const, message: "no" },
    ])
      await withHome(dir, {}, async () => {
        const running = ExternalCodex.start({
          cwd,
          prompt: "Create note.txt",
          executable: FAKE_CODEX,
          ask: async () => (asked++, answer),
        })
        await running.done
        await new Promise((resolve) =>
          running.child.exitCode !== null ? resolve(null) : running.child.once("close", resolve),
        )
      })
    expect(asked).toBeGreaterThanOrEqual(3)
    expect(await snapshot(dir)).toEqual(before)
  })
})

// XCOD-285 §4: Settings › External sessions › Claude Code / Codex reads each tool's configuration and
// changes it only with the tool's own command, once the user confirmed it. Reading, and showing the
// command, leave ~/.claude and ~/.codex byte-identical; a confirmed command changes exactly the file it named.
describe("the tools' configuration view leaves ~/.claude and ~/.codex untouched unless a confirmed command ran (XCOD-285 §4)", () => {
  test("reading both tools changes no file, and Claude Code is read with hooks off", async () => {
    const dir = await home()
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-work-"))
    const log = path.join(cwd, "..", `fake-claude-${path.basename(cwd)}.jsonl`)
    const before = await snapshot(dir)
    await withHome(dir, { FAKE_CLAUDE_LOG: log }, async () => {
      const claude = await ExternalConfig.read({ tool: "claude", executable: FAKE_CLAUDE, cwd })
      const codex = await ExternalConfig.read({ tool: "codex", executable: FAKE_CODEX, cwd })
      expect(claude.sections.length).toBeGreaterThan(0)
      expect(codex.sections.length).toBeGreaterThan(0)
    })
    expect(await snapshot(dir)).toEqual(before)
    expect(await snapshot(cwd)).toEqual({})
    const argv = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).argv as string[] | undefined)
      .find((value) => value?.includes("--settings"))!
    // The settings file Lunos passed is gone after the read; it held only disableAllHooks.
    expect(argv).toContain("--no-session-persistence")
    expect(argv[argv.indexOf("--settings") + 1]).toMatch(/settings\.json$/)
  })

  test("a command shown but not confirmed changes nothing", async () => {
    const dir = await home()
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-work-"))
    const before = await snapshot(dir)
    const claude = ExternalConfig.plan(
      "claude",
      { action: "mcp.add", name: "docs", scope: "user", target: "npx docs-mcp" },
      { cwd, home: dir, scopes: ["local", "user", "project"] },
    )
    const codex = ExternalConfig.plan(
      "codex",
      { action: "mcp.add", name: "docs", target: "npx docs-mcp" },
      { cwd, userFile: path.join(dir, ".codex", "config.toml") },
    )
    expect(claude.file).toBe(path.join(dir, ".claude.json"))
    expect(codex.file).toBe(path.join(dir, ".codex", "config.toml"))
    expect(await snapshot(dir)).toEqual(before)
  })

  test("a confirmed command changes exactly the file it named, and nothing else", async () => {
    const dir = await home()
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-work-"))
    const before = await snapshot(dir)
    const claude = ExternalConfig.plan(
      "claude",
      { action: "mcp.add", name: "docs", scope: "user", target: "npx docs-mcp" },
      { cwd, home: dir, scopes: ["local", "user", "project"] },
    )
    const codex = ExternalConfig.plan(
      "codex",
      { action: "mcp.add", name: "docs", target: "https://mcp.example.com/mcp" },
      { cwd, userFile: path.join(dir, ".codex", "config.toml") },
    )
    await withHome(dir, {}, async () => {
      expect((await ExternalConfig.run(FAKE_CLAUDE, claude, cwd)).ok).toBe(true)
      expect((await ExternalConfig.run(FAKE_CODEX, codex, cwd)).ok).toBe(true)
    })
    const after = await snapshot(dir)
    const changed = Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key])
    expect(changed.sort()).toEqual([path.relative(dir, claude.file!), path.relative(dir, codex.file!)].sort())
    expect(await snapshot(cwd)).toEqual({})
  })
})
