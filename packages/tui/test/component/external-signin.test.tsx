/** @jsxImportSource @opentui/solid */
// XCOD-294: `/claude <task>` with a Claude Code that's installed but not signed in. Driven by keys in a
// headless 120x45 terminal against a fake server whose /experimental/external/tools asks the fake
// Claude Code (test/external/fixtures/fake-claude.ts, FAKE_CLAUDE_AUTH) for its `auth status`, as the
// server's detection does: Lunos offers the tool's own sign-in, runs `claude auth login` on the terminal,
// asks again, then starts the session with the task. The token the fake login makes up must not reach
// anything Lunos sends, receives or draws.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { LOGIN_ARGS, loginCommand, loginEnvironment, loginIsLocal, runLogin } from "../../src/util/external-login"

const FAKE_CLAUDE = path.resolve(import.meta.dir, "../../../opencode/test/external/fixtures/fake-claude.ts")
const FAKE_CODEX = path.resolve(import.meta.dir, "../../../opencode/test/external/fixtures/fake-codex.ts")

let lastFrame: (() => string) | undefined
async function wait(fn: () => boolean, timeout = 8000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for condition${lastFrame ? `; screen:\n${lastFrame()}` : ""}`)
    await Bun.sleep(10)
  }
}

type Seen = { method: string; url: string; body?: string; response?: string }

const AGENT = { name: "build", mode: "primary", permission: [], options: {} }

const saved = { claude: process.env.FAKE_CLAUDE_AUTH }
afterEach(() => {
  if (saved.claude === undefined) delete process.env.FAKE_CLAUDE_AUTH
  else process.env.FAKE_CLAUDE_AUTH = saved.claude
})

async function mount(input: { serverHome?: string } = {}) {
  const tmp = await tmpdir()
  const auth = path.join(tmp.path, "claude-credentials")
  // The fake reads where its sign-in lives from the environment it's started with, the user's own.
  process.env.FAKE_CLAUDE_AUTH = auth
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const seen: Seen[] = []
  const frames: string[] = []
  const created = {
    id: "ses_claude",
    slug: "ses_claude",
    projectID: "proj_test",
    directory,
    title: "fix the bug",
    version: "1",
    time: { created: 2, updated: 2 },
    metadata: { external: { tool: "claude" } },
  }
  const sessions: unknown[] = []
  const events = createEventSource()
  const base = createFetch(undefined, events)
  // What the server's ExternalDetect.detect makes of `claude auth status` (JSON, exit 1 when signed out).
  const detect = () => {
    const status = spawnSync(process.execPath, [FAKE_CLAUDE, "auth", "status"], { env: process.env, encoding: "utf8" })
    const parsed = JSON.parse(status.stdout) as { loggedIn: boolean }
    return [
      {
        tool: "claude",
        label: "Claude Code",
        installed: true,
        loggedIn: parsed.loggedIn,
        ...(parsed.loggedIn ? {} : { hint: "Log in to Claude Code first: run `claude auth login` in a terminal" }),
      },
      { tool: "codex", label: "Codex CLI", installed: false },
    ]
  }
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const url = new URL(req.url)
    const method = req.method
    const body = method === "GET" ? undefined : await req.clone().text()
    const respond = (data: unknown) => {
      seen.push({ method, url: req.url, body, response: JSON.stringify(data) })
      return json(data)
    }
    if (url.pathname === "/experimental/external/tools") return respond(detect())
    if (url.pathname === "/path")
      return respond({
        home: input.serverHome ?? Global.Path.home,
        state: "",
        config: "",
        worktree: tmp.path,
        directory,
      })
    if (url.pathname === "/config") return respond({ external: { claude: { path: FAKE_CLAUDE } } })
    if (url.pathname === "/session" && method === "POST") {
      sessions.push(created)
      return respond(created)
    }
    if (url.pathname === "/session" && method === "GET") return respond(sessions)
    if (url.pathname === "/session/ses_claude" && method === "GET") return respond(created)
    if (url.pathname === "/agent") return respond([AGENT])
    if (url.pathname === "/permission" || url.pathname === "/question") return respond([])
    if (/^\/session\/[^/]+\/(message|todo|diff)$/.test(url.pathname) && method === "GET") return respond([])
    if (method === "POST") return respond(true)
    seen.push({ method, url: req.url, body })
    return base.fetch(req)
  }) as typeof globalThis.fetch

  const [
    { ArgsProvider },
    { KVProvider },
    { ToastProvider, Toast },
    { RouteProvider, useRoute },
    { TuiConfigProvider },
    { SDKProvider },
    { PermissionProvider },
    { ProjectProvider, useProject },
    { SyncProvider, useSync },
    { DataProvider },
    { ThemeProvider },
    { LocalProvider },
    { PromptStashProvider },
    { DialogProvider },
    { FrecencyProvider },
    { PromptHistoryProvider },
    { PromptRefProvider, usePromptRef },
    { EditorContextProvider },
    { LocationProvider },
    { ExitProvider },
    { ClipboardProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { Prompt },
  ] = await Promise.all([
    import("../../src/context/args"),
    import("../../src/context/kv"),
    import("../../src/ui/toast"),
    import("../../src/context/route"),
    import("../../src/config"),
    import("../../src/context/sdk"),
    import("../../src/context/permission"),
    import("../../src/context/project"),
    import("../../src/context/sync"),
    import("../../src/context/data"),
    import("../../src/context/theme"),
    import("../../src/context/local"),
    import("../../src/component/prompt/stash"),
    import("../../src/ui/dialog"),
    import("../../src/component/prompt/frecency"),
    import("../../src/component/prompt/history"),
    import("../../src/context/prompt"),
    import("../../src/context/editor"),
    import("../../src/context/location"),
    import("../../src/context/exit"),
    import("../../src/context/clipboard"),
    import("../../src/keymap"),
    import("../../src/component/prompt"),
  ])

  let route: ReturnType<typeof useRoute> | undefined
  function View() {
    const sync = useSync()
    const project = useProject()
    const promptRef = usePromptRef()
    route = useRoute()
    const [ready, setReady] = createSignal(false)
    onMount(() => {
      void wait(() => sync.status !== "loading" && !!project.instance.path().home).then(() => setReady(true))
    })
    return (
      <box>
        <Show when={ready()}>
          <Prompt ref={(ref) => promptRef.set(ref)} placeholders={{ normal: ["Ask anything"] }} />
        </Show>
        <Toast />
      </box>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ExitProvider exit={() => {}}>
          <ClipboardProvider>
            <OpencodeKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <TuiConfigProvider config={config}>
                        <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                          <PermissionProvider>
                            <ProjectProvider>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark">
                                    <LocalProvider>
                                      <PromptStashProvider>
                                        <DialogProvider>
                                          <FrecencyProvider>
                                            <PromptHistoryProvider>
                                              <PromptRefProvider>
                                                <EditorContextProvider>
                                                  <LocationProvider>
                                                    <View />
                                                  </LocationProvider>
                                                </EditorContextProvider>
                                              </PromptRefProvider>
                                            </PromptHistoryProvider>
                                          </FrecencyProvider>
                                        </DialogProvider>
                                      </PromptStashProvider>
                                    </LocalProvider>
                                  </ThemeProvider>
                                </DataProvider>
                              </SyncProvider>
                            </ProjectProvider>
                          </PermissionProvider>
                        </SDKProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </OpencodeKeymapProvider>
          </ClipboardProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 120, height: 45 })
  const frame = () => {
    const text = app.captureCharFrame()
    frames.push(text)
    return text
  }
  lastFrame = frame
  await wait(() => frame().includes("Ask anything"))
  await Bun.sleep(100)
  const settle = () => Bun.sleep(80)
  return {
    auth,
    frame,
    frames,
    seen,
    route: () => route?.data,
    async type(text: string) {
      await app.mockInput.typeText(text)
      await settle()
    },
    async enter() {
      app.mockInput.pressEnter()
      await settle()
    },
    async escape() {
      app.mockInput.pressEscape()
      await settle()
    },
    async cleanup() {
      await Bun.sleep(50)
      app.renderer.destroy()
      void tmp[Symbol.asyncDispose]()
    },
  }
}

const posts = (ui: { seen: Seen[] }, pattern: RegExp) =>
  ui.seen.filter((item) => item.method === "POST" && pattern.test(new URL(item.url).pathname))

describe("/claude when Claude Code isn't signed in", () => {
  test("offers its own sign-in, runs `claude auth login` on the terminal, then starts the session", async () => {
    const ui = await mount()
    try {
      expect(existsSync(ui.auth)).toBe(false)
      await ui.type("/claude fix the bug")
      await ui.enter()
      await wait(() => ui.frame().includes("Claude Code isn't signed in"))
      const offer = ui.frame()
      expect(offer).toContain("claude auth login")
      expect(offer).toContain("Sign in")
      expect(offer).toContain("Not now")
      // Nothing started before the user says yes.
      expect(posts(ui, /^\/session$/)).toHaveLength(0)

      await ui.enter()
      // The fake's login wrote its token where Claude Code keeps it; Lunos asked again and carried on.
      await wait(() => posts(ui, /^\/session$/).length === 1)
      expect(existsSync(ui.auth)).toBe(true)
      expect(JSON.parse(posts(ui, /^\/session$/)[0]!.body!)).toEqual({ metadata: { external: { tool: "claude" } } })
      await wait(() => posts(ui, /^\/session\/ses_claude\/(prompt|message)/).length === 1)
      expect(posts(ui, /^\/session\/ses_claude\/(prompt|message)/)[0]!.body).toContain("fix the bug")
      expect(ui.route()).toMatchObject({ type: "session", sessionID: "ses_claude" })
      await wait(() => ui.frame().includes("Signed in to Claude Code"))

      // The credential stayed between Claude Code and the terminal.
      const token = readFileSync(ui.auth, "utf8")
      expect(token).toMatch(/^sk-fake-/)
      for (const item of ui.seen) {
        expect(item.url).not.toContain(token)
        expect(item.body ?? "").not.toContain(token)
        expect(item.response ?? "").not.toContain(token)
      }
      for (const text of ui.frames) expect(text).not.toContain(token)
      expect(Object.values(process.env).some((value) => value?.includes(token))).toBe(false)
    } finally {
      await ui.cleanup()
    }
  })

  test("Not now starts nothing and runs nothing", async () => {
    const ui = await mount()
    try {
      await ui.type("/claude fix the bug")
      await ui.enter()
      await wait(() => ui.frame().includes("Claude Code isn't signed in"))
      await ui.escape()
      await Bun.sleep(300)
      expect(existsSync(ui.auth)).toBe(false)
      expect(posts(ui, /^\/session$/)).toHaveLength(0)
    } finally {
      await ui.cleanup()
    }
  })

  test("a server elsewhere (attached, another home): says how to sign in there, runs nothing here", async () => {
    const ui = await mount({ serverHome: "/home/someone-else" })
    try {
      await ui.type("/claude fix the bug")
      await ui.enter()
      await wait(() => ui.frame().includes("isn't signed in where Lunos runs it"))
      expect(ui.frame()).toContain("claude auth login")
      expect(ui.frame()).not.toContain("Not now")
      await Bun.sleep(200)
      expect(existsSync(ui.auth)).toBe(false)
      expect(posts(ui, /^\/session$/)).toHaveLength(0)
    } finally {
      await ui.cleanup()
    }
  })
})

describe("the login command", () => {
  test("is the tool's own, with this terminal as its stdin, stdout and stderr", async () => {
    expect(LOGIN_ARGS).toEqual({ claude: ["auth", "login"], codex: ["login"] })
    expect(loginCommand("codex", "/usr/local/bin/codex")).toEqual({
      file: "/usr/local/bin/codex",
      args: ["login"],
      shell: false,
    })
    expect(loginCommand("claude", FAKE_CLAUDE)).toEqual({
      file: process.execPath,
      args: [FAKE_CLAUDE, "auth", "login"],
      shell: false,
    })
    const tmp = await tmpdir()
    const auth = path.join(tmp.path, "codex-credentials")
    const before = process.env.FAKE_CODEX_AUTH
    process.env.FAKE_CODEX_AUTH = auth
    const started: { file: string; args: string[]; options: Record<string, unknown> }[] = []
    const calls: string[] = []
    const renderer = {
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
      requestRender: () => {},
      currentRenderBuffer: { clear() {} },
    }
    try {
      const code = await runLogin({
        tool: "codex",
        file: FAKE_CODEX,
        renderer,
        spawn: ((file: string, args: string[], options: Record<string, unknown>) => {
          started.push({ file, args, options })
          calls.push("spawn")
          return spawn(file, args, options)
        }) as never,
      })
      expect(code).toBe(0)
      expect(existsSync(auth)).toBe(true)
      expect(calls).toEqual(["suspend", "spawn", "resume"])
      expect(started).toHaveLength(1)
      expect(started[0]!.args).toEqual([FAKE_CODEX, "login"])
      // Not piped: Lunos holds no handle on what the user types or the tool prints.
      expect(started[0]!.options.stdio).toBe("inherit")
    } finally {
      if (before === undefined) delete process.env.FAKE_CODEX_AUTH
      else process.env.FAKE_CODEX_AUTH = before
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("a login that can't start resolves null, and the TUI comes back", async () => {
    const calls: string[] = []
    const renderer = {
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
      requestRender: () => {},
      currentRenderBuffer: { clear() {} },
    }
    expect(await runLogin({ tool: "claude", file: "/nonexistent/claude", renderer })).toBeNull()
    expect(calls).toEqual(["suspend", "resume"])
  })

  test("runs only where the server's tool reads it, without what a parent Claude Code injects", () => {
    expect(loginIsLocal({ sandbox: false, serverHome: "/Users/me", home: "/Users/me" })).toBe(true)
    expect(loginIsLocal({ sandbox: true, serverHome: "/Users/me", home: "/Users/me" })).toBe(false)
    expect(loginIsLocal({ sandbox: false, serverHome: "/home/me", home: "/Users/me" })).toBe(false)
    expect(loginIsLocal({ sandbox: false, serverHome: "", home: "/Users/me" })).toBe(false)
    expect(loginEnvironment({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", HOME: "/h" })).toEqual({
      PATH: "/bin",
      HOME: "/h",
    })
  })
})
