/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

// XCOD-285 §4: Settings › External sessions › Claude Code / Codex, rendered headlessly at 120x45 with
// the server mocked: the tool's sections with their scopes and "source unknown", and changes that show
// the tool's own command and the file it changes, run only after the user confirms (one POST with
// run: true), and never when they cancel.

const CLAUDE = {
  tool: "claude",
  label: "Claude Code",
  version: "2.1.304",
  sections: [
    {
      id: "general",
      title: "Model and permissions",
      items: [
        {
          id: "model",
          name: "Model",
          value: "opus[1m]",
          source: { scope: "user", file: "/h/.claude/settings.json", label: "User settings (~/.claude/settings.json)" },
          open: "/h/.claude/settings.json",
        },
        {
          id: "permission-mode",
          name: "Permission mode",
          value: "auto",
          detail:
            "Lunos starts its Claude Code sessions in default (external.claude.permission_mode), whatever this says",
          source: { scope: "user", label: "User settings (~/.claude/settings.json)" },
        },
      ],
    },
    {
      id: "mcp",
      title: "MCP servers",
      items: [
        {
          id: "mcp:user:docs",
          name: "docs",
          value: "stdio npx",
          status: "connected",
          source: { scope: "user", file: "/h/.claude.json", label: "user (~/.claude.json)" },
          remove: { scope: "user" },
        },
        {
          id: "mcp:dynamic:plugin:x:y",
          name: "plugin:x:y",
          value: "http https://mcp.example.com/mcp",
          source: { scope: "plugin", label: "from a plugin" },
        },
      ],
      add: { scopes: ["local", "user", "project"], url: true },
    },
    {
      id: "agents",
      title: "Agents",
      items: [{ id: "agent:Explore", name: "Explore", value: "Fast read-only search agent" }],
      note: "Claude Code doesn't say where an agent comes from",
    },
  ],
  notes: ["Read by starting Claude Code without a prompt, with hooks off and no saved session."],
}

const CODEX = {
  tool: "codex",
  label: "Codex CLI",
  version: "0.160.1",
  sections: [
    {
      id: "general",
      title: "Model and permissions",
      items: [
        {
          id: "sandbox_mode",
          name: "Sandbox",
          value: "read-only",
          source: { scope: "project", file: "/p/.codex/config.toml", label: "project (/p/.codex/config.toml)" },
        },
      ],
    },
    { id: "instructions", title: "AGENTS.md files", items: [], note: "Codex loads no AGENTS.md file here" },
  ],
  notes: [],
}

type Call = { path: string; method: string; body?: any }

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(input: { root: string; tool: "claude" | "codex"; view: unknown }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const calls: Call[] = []
  const events = createEventSource()
  const base = createFetch((url) => {
    if (url.pathname === "/api/event") return events.response()
    return undefined
  }, events)
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const text = req.method === "GET" ? "" : await req.clone().text()
    const pathname = new URL(req.url).pathname
    calls.push({ path: pathname, method: req.method, body: text ? JSON.parse(text) : undefined })
    if (pathname === `/experimental/external/config/${input.tool}`) return json(input.view)
    if (pathname === `/experimental/external/config/${input.tool}/command`) {
      const body = JSON.parse(text)
      const scope = body.scope ? ` -s ${body.scope}` : ""
      const command =
        body.action === "mcp.remove"
          ? `claude mcp remove ${body.name}${scope}`
          : `claude mcp add${scope} ${body.name} -- ${body.target}`
      const file = body.scope === "project" ? "/p/.mcp.json" : "/h/.claude.json"
      return json(
        body.run
          ? { command, file, ran: true, ok: true, output: `Done: ${body.name}. File modified: ${file}` }
          : { command, file, ran: false },
      )
    }
    return base.fetch(req)
  }) as typeof globalThis.fetch

  const [
    { ArgsProvider },
    { KVProvider },
    { SDKProvider },
    { SyncProvider, useSync },
    { ProjectProvider },
    { PermissionProvider },
    { ExitProvider },
    { DialogProvider, useDialog },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { DialogExternalConfig },
  ] = await Promise.all([
    import("../../src/context/args"),
    import("../../src/context/kv"),
    import("../../src/context/sdk"),
    import("../../src/context/sync"),
    import("../../src/context/project"),
    import("../../src/context/permission"),
    import("../../src/context/exit"),
    import("../../src/ui/dialog"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/component/dialog-external-config"),
  ])

  function Start() {
    const sync = useSync()
    const dialog = useDialog()
    onMount(async () => {
      await wait(() => sync.status === "complete")
      dialog.replace(() => <DialogExternalConfig tool={input.tool} />)
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state, worktree: input.root }}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
              <PermissionProvider>
                <ProjectProvider>
                  <ExitProvider exit={() => {}}>
                    <SyncProvider>
                      <OpencodeKeymapProvider keymap={keymap}>
                        <TuiConfigProvider config={config}>
                          <ThemeProvider mode="dark">
                            <ToastProvider>
                              <DialogProvider>
                                <Start />
                              </DialogProvider>
                            </ToastProvider>
                          </ThemeProvider>
                        </TuiConfigProvider>
                      </OpencodeKeymapProvider>
                    </SyncProvider>
                  </ExitProvider>
                </ProjectProvider>
              </PermissionProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 120, height: 45, kittyKeyboard: true })
  const frame = () => app.captureCharFrame()
  const see = async (text: string) => {
    try {
      await wait(() => frame().includes(text))
    } catch {
      throw new Error(`"${text}" never appeared. Last frame:\n${frame()}`)
    }
  }
  const commands = (run: boolean) =>
    calls.filter((call) => call.path.endsWith("/command") && call.method === "POST" && call.body?.run === run)
  return {
    app,
    calls,
    commands,
    frame,
    see,
    async enter() {
      app.mockInput.pressEnter()
      await Bun.sleep(80)
    },
    async type(text: string) {
      app.mockInput.typeText(text)
      await Bun.sleep(80)
    },
    async down(times = 1) {
      for (let i = 0; i < times; i++) {
        app.mockInput.pressArrow("down")
        await Bun.sleep(30)
      }
    },
    async right() {
      app.mockInput.pressArrow("right")
      await Bun.sleep(30)
    },
    cleanup: () => app.renderer.destroy(),
  }
}

test("Claude Code: its sections, each value's scope, and source unknown where the tool doesn't say", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, tool: "claude", view: CLAUDE })
  try {
    await ui.see("Model and permissions")
    const frame = ui.frame()
    expect(frame).toContain("Settings › External sessions › Claude Code")
    expect(frame).toContain("version 2.1.304")
    expect(frame).toContain("opus[1m]")
    expect(frame).toContain("MCP servers")
    expect(frame).toContain("connected · user")
    expect(frame).toContain("Add an MCP server…")
    expect(frame).toContain("Agents")
    expect(frame).toContain("source unknown")
    // The highlighted row says where it comes from; the read's note is at the bottom.
    expect(frame).toContain("from User settings (~/.claude/settings.json)")
    expect(frame).toContain("with hooks off")
    // No vendor logo: only the tool's plain name.
    expect(frame).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
  } finally {
    ui.cleanup()
  }
})

test("an agent the tool doesn't attribute: source unknown, and nothing to change", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, tool: "claude", view: CLAUDE })
  try {
    await ui.see("Model and permissions")
    await ui.type("Explore")
    await ui.see("source unknown: Claude Code doesn't say where this comes from")
    await ui.see("Nothing to do here: Claude Code has no command to change it")
    await ui.enter()
    expect(ui.commands(false)).toHaveLength(0)
  } finally {
    ui.cleanup()
  }
})

test("removing a server shows the command and the file; cancel runs nothing, confirm runs it once", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, tool: "claude", view: CLAUDE })
  try {
    await ui.see("Model and permissions")
    await ui.type("docs")
    await ui.enter()
    await ui.see("Remove with Claude Code's own command")
    await ui.down()
    await ui.enter()
    await ui.see("Run Claude Code's own command?")
    expect(ui.frame()).toContain("claude mcp remove docs -s user")
    expect(ui.frame()).toContain("Claude Code changes /h/.claude.json")
    expect(ui.commands(false)).toHaveLength(1)
    // Cancel (← moves to it, enter chooses it): no command runs.
    await ui.right()
    await ui.enter()
    await ui.see("Model and permissions")
    expect(ui.commands(true)).toHaveLength(0)

    await ui.type("docs")
    await ui.enter()
    await ui.see("Remove with Claude Code's own command")
    await ui.down()
    await ui.enter()
    await ui.see("Run Claude Code's own command?")
    await ui.enter()
    await wait(() => ui.commands(true).length === 1)
    await ui.see("Done: docs. File modified: /h/.claude.json")
    expect(ui.commands(true)).toHaveLength(1)
    expect(ui.commands(true)[0]!.body).toEqual({ action: "mcp.remove", name: "docs", scope: "user", run: true })
  } finally {
    ui.cleanup()
  }
})

test("adding a server: the scope the tool lists, a name and a command, then the command and file before it runs", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, tool: "claude", view: CLAUDE })
  try {
    await ui.see("Model and permissions")
    await ui.type("Add an MCP")
    await ui.enter()
    await ui.see("Where Claude Code keeps the server")
    expect(ui.frame()).toContain("project")
    await ui.down(2)
    await ui.enter()
    await ui.see("Server name")
    await ui.type("web")
    await ui.enter()
    await ui.see("URL, or the command that starts it")
    await ui.type("npx -y web-mcp")
    await ui.enter()
    await ui.see("Run Claude Code's own command?")
    expect(ui.frame()).toContain("claude mcp add -s project web -- npx -y web-mcp")
    expect(ui.frame()).toContain("Claude Code changes /p/.mcp.json")
    expect(ui.commands(true)).toHaveLength(0)
    await ui.enter()
    await wait(() => ui.commands(true).length === 1)
    expect(ui.commands(true)[0]!.body).toEqual({
      action: "mcp.add",
      name: "web",
      scope: "project",
      target: "npx -y web-mcp",
      run: true,
    })
  } finally {
    ui.cleanup()
  }
})

test("Codex: the layer each value comes from, and a section with nothing in it says so", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({ root: tmp.path, tool: "codex", view: CODEX })
  try {
    await ui.see("Settings › External sessions › Codex CLI")
    const frame = ui.frame()
    expect(frame).toContain("read-only")
    expect(frame).toContain("project")
    expect(frame).toContain("from project (/p/.codex/config.toml)")
    expect(frame).toContain("Codex loads no AGENTS.md file here")
    expect(frame).not.toContain("Add an MCP server…")
  } finally {
    ui.cleanup()
  }
})

test("a tool that can't be read says why, and lists nothing", async () => {
  await using tmp = await tmpdir()
  const ui = await mount({
    root: tmp.path,
    tool: "claude",
    view: {
      tool: "claude",
      label: "Claude Code",
      error: "Claude Code sends your code to Anthropic (US), and the data-residency policy allows only: eu.",
      sections: [],
      notes: [],
    },
  })
  try {
    await ui.see("Claude Code sends your code to Anthropic (US)")
    expect(ui.frame()).not.toContain("Model and permissions")
  } finally {
    ui.cleanup()
  }
})
