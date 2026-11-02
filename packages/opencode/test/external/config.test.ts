import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { readFileSync } from "fs"
import os from "os"
import path from "path"
import { ExternalConfig } from "../../src/external/config"

// XCOD-285 §4: Settings › External sessions › Claude Code / Codex. The views are built from the replies
// recorded from Claude Code 2.1.304 and Codex 0.160.1 (test/fixtures/external/*/config-view.json), then
// read end to end through the fake tools, which answer with the same recorded replies.

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "external")
const FAKE_CLAUDE = path.join(import.meta.dir, "fixtures", "fake-claude.ts")
const FAKE_CODEX = path.join(import.meta.dir, "fixtures", "fake-codex.ts")

function recorded(tool: "claude-2.1.304" | "codex-0.160.1", vars: Record<string, string>) {
  let text = readFileSync(path.join(FIXTURES, tool, "config-view.json"), "utf8")
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(key, value)
  return JSON.parse(text).replies
}

async function dirs() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-config-")))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  await fs.mkdir(path.join(home, ".claude", "agents"), { recursive: true })
  await fs.mkdir(path.join(home, ".codex"), { recursive: true })
  await fs.mkdir(project, { recursive: true })
  return { root, home, project }
}

const items = (view: { sections: { id: string; items: any[] }[] }, id: string) =>
  view.sections.find((section) => section.id === id)?.items ?? []

describe("Claude Code's configuration, from 2.1.304's replies", () => {
  test("every section, with the layer the tool reports and the documented file only when it exists", async () => {
    const { home, project } = await dirs()
    await fs.writeFile(path.join(home, ".claude", "settings.json"), "{}\n")
    await fs.writeFile(path.join(project, "CLAUDE.md"), "# project\n")
    await fs.writeFile(path.join(home, ".claude.json"), "{}\n")
    await fs.writeFile(
      path.join(home, ".claude", "agents", "clarify.md"),
      "---\nname: agent-clarifier\ndescription: x\n---\nbody\n",
    )
    const view = ExternalConfig.claudeView({
      replies: recorded("claude-2.1.304", { "<home>": home, "<project>": project }),
      cwd: project,
      home,
      add: { scopes: ["local", "user", "project"], transports: ["stdio", "sse", "http"] },
      remove: true,
      lunosMode: "acceptEdits",
    })
    expect(view.version).toBe("2.1.304")
    expect(view.sections.map((section) => section.id)).toEqual([
      "general",
      "instructions",
      "mcp",
      "hooks",
      "agents",
      "files",
    ])

    const general = items(view, "general")
    const model = general.find((item) => item.id === "model")
    expect(model.value).toBe("opus[1m]")
    expect(model.source).toEqual({
      scope: "user",
      file: path.join(home, ".claude", "settings.json"),
      label: "User settings (~/.claude/settings.json)",
    })
    expect(model.open).toBe(path.join(home, ".claude", "settings.json"))
    const mode = general.find((item) => item.id === "permission-mode")
    expect(mode.value).toBe("auto")
    expect(mode.source.scope).toBe("user")
    // What Lunos's sessions use, next to the tool's own default.
    expect(mode.detail).toContain("acceptEdits (external.claude.permission_mode)")
    const style = general.find((item) => item.id === "output-style")
    expect(style.value).toBe("default")
    expect(style.source.label).toBe("not set: Claude Code's default")
    expect(style.detail).toContain("Explanatory")

    // Only the CLAUDE.md files that exist; the user's, reported as missing, isn't listed.
    expect(items(view, "instructions")).toEqual([
      expect.objectContaining({
        name: "Project instructions",
        source: { scope: "project", file: path.join(project, "CLAUDE.md"), label: "Checked in at ./CLAUDE.md" },
        open: path.join(project, "CLAUDE.md"),
      }),
    ])

    const mcp = items(view, "mcp")
    const plugin = mcp.find((item) => item.name.startsWith("plugin:"))
    expect(plugin.source).toEqual({ scope: "plugin", label: "from a plugin" })
    expect(plugin.remove).toBeUndefined()
    expect(plugin.value).toBe("http https://mcp.context7.com/mcp")
    const user = mcp.find((item) => item.name === "MCP_DOCKER")
    expect(user.value).toBe("stdio docker")
    expect(user.status).toBe("pending")
    expect(user.source).toEqual({
      scope: "user",
      file: path.join(home, ".claude.json"),
      label: "user (~/.claude.json)",
    })
    expect(user.remove).toEqual({ scope: "user" })
    // .mcp.json doesn't exist here: the scope without a file.
    const shared = mcp.find((item) => item.name === "agentvibes")
    expect(shared.source).toEqual({ scope: "project", label: "project: shared with the repository" })
    expect(view.sections.find((section) => section.id === "mcp")?.add).toEqual({
      scopes: ["local", "user", "project"],
      url: true,
    })

    const hooks = items(view, "hooks")
    expect(hooks.map((hook) => hook.name)).toEqual(["PostToolUse (*)", "PostToolUse", "SessionStart (startup|resume)"])
    expect(hooks[0].source.file).toBe(path.join(home, ".claude", "settings.json"))
    expect(hooks[1].source).toEqual({
      scope: "plugin",
      label: "Plugin hooks (~/.claude/plugins/*/hooks/hooks.json) · remember@claude-plugins-official",
    })
    // The local settings file doesn't exist here, so there's nothing to open.
    expect(hooks[2].source.scope).toBe("local")
    expect(hooks[2].open).toBeUndefined()

    const agents = items(view, "agents")
    expect(agents.find((agent) => agent.name === "agent-clarifier").source).toEqual({
      scope: "user",
      file: path.join(home, ".claude", "agents", "clarify.md"),
      label: "~/.claude/agents/clarify.md",
    })
    // Built in, or from a plugin: Claude Code doesn't say, so "source unknown".
    expect(agents.find((agent) => agent.name === "Explore").source).toBeUndefined()

    // Lunos's own disableAllHooks for the read isn't shown as the user's command-line settings.
    expect(JSON.stringify(view)).not.toContain("disableAllHooks")
    expect(items(view, "files").map((item) => item.name)).toEqual(["User settings"])
    // No secret from the replies reaches the view.
    expect(JSON.stringify(view)).not.toContain("SECRET")
    expect(JSON.stringify(view)).not.toContain("ANTHROPIC_BASE_URL")
  })

  test("a request the release doesn't answer hides its section", () => {
    const replies = recorded("claude-2.1.304", { "<home>": "/h", "<project>": "/p" })
    const view = ExternalConfig.claudeView({ replies: { initialize: replies.initialize }, cwd: "/p", home: "/h" })
    expect(view.sections.map((section) => section.id)).toEqual(["general", "agents"])
    expect(items(view, "general").map((item) => item.id)).toEqual(["model", "output-style"])
  })

  test("the source of a value set by no reported layer is unknown", () => {
    const settings = { effective: { model: "sonnet" }, sources: [{ source: "userSettings", settings: {} }] }
    expect(ExternalConfig.claudeSourceOf(settings, (value) => value.model)).toBeUndefined()
    const managed = {
      effective: { model: "opus" },
      sources: [
        { source: "policySettings", settings: { model: "opus" } },
        { source: "localSettings", settings: { model: "opus" } },
      ],
    }
    expect(ExternalConfig.claudeSourceOf(managed, (value) => value.model)).toBe("policySettings")
  })

  test("the scopes and transports from `claude mcp add --help`", () => {
    const help =
      '  -s, --scope <scope>          Configuration scope (local, user, or project)\n                               (default: "local")\n  -t, --transport <transport>  Transport type (stdio, sse, http). Defaults to'
    expect(ExternalConfig.claudeAddHelp(help)).toEqual({
      scopes: ["local", "user", "project"],
      transports: ["stdio", "sse", "http"],
    })
  })
})

describe("Codex's configuration, from 0.160.1's replies", () => {
  test("values with the layer config/read names, AGENTS.md files, MCP servers and profiles", async () => {
    const { home, project } = await dirs()
    const codexHome = path.join(home, ".codex")
    await fs.writeFile(path.join(codexHome, "config.toml"), "")
    await fs.writeFile(path.join(codexHome, "AGENTS.md"), "")
    await fs.mkdir(path.join(project, ".codex"))
    await fs.writeFile(path.join(project, ".codex", "config.toml"), "")
    await fs.writeFile(path.join(project, "AGENTS.md"), "")
    const view = ExternalConfig.codexView({
      replies: recorded("codex-0.160.1", { "<codex_home>": codexHome, "<project>": project }),
      add: true,
      remove: true,
    })
    expect(view.sections.map((section) => section.id)).toEqual(["general", "instructions", "mcp", "profiles", "files"])
    const general = items(view, "general")
    expect(general.map((item) => [item.name, item.value, item.source.scope])).toEqual([
      ["Model", "gpt-5.5", "user"],
      ["Approval policy", "on-request", "user"],
      ["Sandbox", "read-only", "project"],
    ])
    expect(general[2].source.file).toBe(path.join(project, ".codex", "config.toml"))
    expect(general[2].detail).toContain("sandbox read-only (external.codex.sandbox)")

    expect(items(view, "instructions").map((item) => [item.source.scope, item.open])).toEqual([
      ["user", path.join(codexHome, "AGENTS.md")],
      ["project", path.join(project, "AGENTS.md")],
    ])

    const mcp = items(view, "mcp")
    expect(mcp.map((item) => [item.name, item.value, item.source?.scope, !!item.remove])).toEqual([
      ["projtool", "stdio projtool", "project", false],
      ["remote", "http https://mcp.example.com/mcp", "user", true],
      ["docs", "stdio npx", "user", true],
    ])
    expect(view.sections.find((section) => section.id === "mcp")?.add).toEqual({ scopes: ["user"], url: true })

    expect(items(view, "profiles").map((item) => [item.name, item.value])).toEqual([
      ["fast", "model gpt-5.5-mini · sandbox_mode workspace-write"],
      ["deep", "model_reasoning_effort high"],
    ])
    // The system layer's file doesn't exist here: listed, nothing to open.
    const files = items(view, "files")
    expect(files.map((item) => [item.name, !!item.open])).toEqual([
      ["project", true],
      ["user", true],
      ["system", false],
    ])
    expect(JSON.stringify(view)).not.toContain("SECRET")
  })
})

describe("read through the installed tool (fakes answering with the recorded replies)", () => {
  async function withHome<T>(home: string, env: Record<string, string>, run: () => Promise<T>) {
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }
    Object.assign(process.env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), ...env })
    try {
      return await run()
    } finally {
      process.env.HOME = saved.HOME
      if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = saved.CODEX_HOME
      for (const key of Object.keys(env)) delete process.env[key]
    }
  }

  test("Claude Code: hooks off, no saved session, no prompt", async () => {
    const { root, home, project } = await dirs()
    const log = path.join(root, "log.jsonl")
    const view = await withHome(home, { FAKE_CLAUDE_LOG: log }, () =>
      ExternalConfig.read({ tool: "claude", executable: FAKE_CLAUDE, cwd: project }),
    )
    expect(view.error).toBeUndefined()
    expect(view.sections.map((section) => section.id)).toContain("mcp")
    expect(view.notes[0]).toContain("hooks off")
    const lines = readFileSync(log, "utf8").trim().split("\n")
    const argv = lines
      .map((line) => JSON.parse(line).argv)
      .find((value: string[] | undefined) => value?.includes("--no-session-persistence"))
    expect(argv).toBeDefined()
    expect(argv).toContain("--settings")
    // The settings file is removed after the read; its content was Lunos's disableAllHooks.
    expect(argv[argv.indexOf("--settings") + 1]).toMatch(/lunos-claude-read-.*settings\.json$/)
    expect(lines.some((line) => line.includes('"type":"user"'))).toBe(false)
    const asked = lines.flatMap((line) => {
      const message = JSON.parse(line)
      return message.request?.subtype ? [message.request.subtype] : []
    })
    expect(asked).toEqual(["initialize", ...ExternalConfig.CLAUDE_REQUESTS])
  })

  test("Claude Code without the requests: their sections are hidden; without --settings: not read at all", async () => {
    const { home, project } = await dirs()
    const partial = await withHome(home, { FAKE_CLAUDE_CONFIG: "none" }, () =>
      ExternalConfig.read({ tool: "claude", executable: FAKE_CLAUDE, cwd: project }),
    )
    expect(partial.sections.map((section) => section.id)).toEqual(["general", "agents"])
    const old = await withHome(home, { FAKE_CLAUDE_OLD: "1" }, () =>
      ExternalConfig.read({ tool: "claude", executable: FAKE_CLAUDE, cwd: project }),
    )
    expect(old.error).toContain("without running your hooks")
    expect(old.sections).toEqual([])
  })

  test("Codex: config/read and the instruction files; an app server without config/read shows only those", async () => {
    const { home, project } = await dirs()
    const view = await withHome(home, {}, () =>
      ExternalConfig.read({ tool: "codex", executable: FAKE_CODEX, cwd: project }),
    )
    expect(view.sections.map((section) => section.id)).toEqual(["general", "instructions", "mcp", "profiles", "files"])
    expect(view.sections.find((section) => section.id === "mcp")?.add).toEqual({ scopes: ["user"], url: true })
    const old = await withHome(home, { FAKE_CODEX_OLD: "1" }, () =>
      ExternalConfig.read({ tool: "codex", executable: FAKE_CODEX, cwd: project }),
    )
    expect(old.sections.map((section) => section.id)).toEqual(["instructions"])
  })
})

describe("the tool's own command for a change", () => {
  const context = { cwd: "/work", home: "/home/me", scopes: ["local", "user", "project"] }

  test("Claude Code: add (a command or a URL) and remove, with the file the scope lives in", () => {
    expect(
      ExternalConfig.plan(
        "claude",
        { action: "mcp.add", name: "docs", scope: "user", target: "npx -y docs-mcp" },
        context,
      ),
    ).toEqual({
      argv: ["mcp", "add", "-s", "user", "docs", "--", "npx", "-y", "docs-mcp"],
      command: "claude mcp add -s user docs -- npx -y docs-mcp",
      file: "/home/me/.claude.json",
    })
    expect(
      ExternalConfig.plan(
        "claude",
        { action: "mcp.add", name: "web", scope: "project", target: "https://mcp.example.com/mcp" },
        context,
      ),
    ).toEqual({
      argv: ["mcp", "add", "-s", "project", "--transport", "http", "web", "https://mcp.example.com/mcp"],
      command: "claude mcp add -s project --transport http web https://mcp.example.com/mcp",
      file: "/work/.mcp.json",
    })
    expect(ExternalConfig.plan("claude", { action: "mcp.remove", name: "docs", scope: "local" }, context)).toEqual({
      argv: ["mcp", "remove", "docs", "-s", "local"],
      command: "claude mcp remove docs -s local",
      file: "/home/me/.claude.json",
    })
  })

  test("Codex: add and remove change the user config Codex reports", () => {
    const codex = { cwd: "/work", userFile: "/home/me/.codex/config.toml" }
    expect(
      ExternalConfig.plan("codex", { action: "mcp.add", name: "web", target: "https://x.example/mcp" }, codex),
    ).toEqual({
      argv: ["mcp", "add", "web", "--url", "https://x.example/mcp"],
      command: "codex mcp add web --url https://x.example/mcp",
      file: "/home/me/.codex/config.toml",
    })
    expect(ExternalConfig.plan("codex", { action: "mcp.remove", name: "docs" }, codex).command).toBe(
      "codex mcp remove docs",
    )
  })

  test("refuses what isn't a plain name, a listed scope, or plain words", () => {
    const bad = [
      { action: "mcp.add", name: "a b", scope: "user", target: "x" },
      { action: "mcp.add", name: "--help", scope: "user", target: "x" },
      { action: "mcp.add", name: "ok", scope: "global", target: "x" },
      { action: "mcp.add", name: "ok", scope: "user", target: "" },
      { action: "mcp.add", name: "ok", scope: "user", target: "npx x; rm -rf ~" },
      { action: "mcp.add", name: "ok", scope: "user", target: "https://a.example/x https://b.example" },
    ] as const
    for (const change of bad) expect(() => ExternalConfig.plan("claude", change, context)).toThrow()
    // Through a Windows shell (an npm .cmd shim), only plain words.
    expect(() =>
      ExternalConfig.plan(
        "claude",
        { action: "mcp.add", name: "ok", scope: "user", target: "npx x^y" },
        { ...context, shell: true },
      ),
    ).toThrow()
  })
})
