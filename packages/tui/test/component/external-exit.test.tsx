/** @jsxImportSource @opentui/solid */
// XCOD-286: exit inside a Claude Code / Codex session closes that session and returns to the view it
// was opened from; Lunos keeps running. Driven by keys in a headless 120x45 terminal against a fake
// server, with the app's own exit commands and global exit binding (useExternalExit, as app.tsx
// registers them) and the exit Lunos would call recorded.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { closedMessage, exitIntent, runningMessage } from "../../src/component/external-exit"

let lastFrame: (() => string) | undefined
async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for condition${lastFrame ? `; screen:\n${lastFrame()}` : ""}`)
    await Bun.sleep(10)
  }
}

type Tool = "claude" | "codex"
type Call = { path: string; body?: any }

const session = (id: string, title: string, tool?: Tool) => ({
  id,
  slug: id,
  projectID: "proj_test",
  directory,
  title,
  version: "1",
  time: { created: 1, updated: 1 },
  // With the bridge line, the longest the footer's left side gets in an external session.
  ...(tool
    ? {
        metadata: {
          external: {
            tool,
            session: `${tool}-thread`,
            bridge: {
              servers: 0,
              skills: 0,
              memory: false,
              off: "needs a Claude Code whose --help lists --mcp-config",
            },
          },
        },
      }
    : {}),
})

const AGENT = { name: "build", mode: "primary", permission: [], options: {} }
const PROVIDER = {
  id: "fake",
  name: "Fake",
  source: "config",
  env: [],
  options: {},
  models: {
    "fake-1": {
      id: "fake-1",
      providerID: "fake",
      name: "Fake 1",
      api: { id: "fake-1", url: "", npm: "" },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1000, output: 1000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

/**
 * The view: a Lunos session `ses_lunos` was open, then the session under test. The prompt is shown
 * on whichever session the route is on; `@route` on screen says where it is.
 */
async function mount(input: { tool?: Tool; busy?: boolean; pending?: boolean }) {
  const target = input.tool ? "ses_ext" : "ses_lunos"
  const sessions = [
    session("ses_lunos", "lunos work"),
    ...(input.tool ? [session("ses_ext", "fix-auth", input.tool)] : []),
  ]
  const calls: Call[] = []
  const exits: unknown[] = []
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const base = createFetch(undefined, events)
  const permission = {
    id: "per_1",
    sessionID: target,
    permission: "external",
    patterns: ["Bash"],
    metadata: {},
    always: [],
  }
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const url = new URL(req.url)
    const method = req.method
    if (url.pathname === "/session" && method === "GET") return json(sessions)
    if (url.pathname === "/session/status") return json(input.busy ? { [target]: { type: "busy" } } : {})
    if (url.pathname === "/config/providers") return json({ providers: [PROVIDER], default: { fake: "fake-1" } })
    if (url.pathname === "/agent") return json([AGENT])
    if (url.pathname === "/permission" && method === "GET") return json(input.pending ? [permission] : [])
    if (url.pathname === "/question" && method === "GET") return json([])
    if (/^\/session\/[^/]+$/.test(url.pathname) && method === "GET") {
      const found = sessions.find((item) => item.id === url.pathname.split("/")[2])
      return found ? json(found) : new Response("not found", { status: 404 })
    }
    if (/^\/session\/[^/]+\/(message|todo|diff)$/.test(url.pathname) && method === "GET") return json([])
    if (method === "POST") {
      const text = await req.clone().text()
      calls.push({ path: url.pathname, ...(text ? { body: JSON.parse(text) } : {}) })
      return json(true)
    }
    return base.fetch(req)
  }) as typeof globalThis.fetch

  const [
    { ArgsProvider },
    { KVProvider },
    { ToastProvider, useToast },
    routeModule,
    { TuiConfigProvider, useTuiConfig },
    { SDKProvider },
    { PermissionProvider },
    { ProjectProvider },
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
    keymapModule,
    { Prompt },
    { useExternalExit },
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
    import("../../src/component/external-exit"),
  ])
  const { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings, OPENCODE_BASE_MODE } = keymapModule
  const { RouteProvider, useRoute } = routeModule

  let toast!: ReturnType<typeof useToast>
  let route!: ReturnType<typeof useRoute>
  function View() {
    const sync = useSync()
    const tuiConfig = useTuiConfig()
    const promptRef = usePromptRef()
    const externalExit = useExternalExit()
    toast = useToast()
    route = useRoute()
    const [ready, setReady] = createSignal(false)
    onMount(() => {
      route.navigate({ type: "session", sessionID: "ses_lunos" })
      if (target !== "ses_lunos") route.navigate({ type: "session", sessionID: target })
      void wait(() => sync.status !== "loading" && !!sync.session.get(target)).then(() => setReady(true))
    })
    // As app.tsx registers them.
    useBindings(() => ({ commands: externalExit.commands().map((command) => ({ namespace: "palette", ...command })) }))
    useBindings(() => ({
      mode: OPENCODE_BASE_MODE,
      enabled: () => externalExit.globalKeys(promptRef.current),
      bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
    }))
    const where = () =>
      route.data.type === "session" ? `@route session ${route.data.sessionID}` : `@route ${route.data.type}`
    return (
      <box>
        <text>{where()}</text>
        <Show
          when={ready() && route.data.type === "session" ? (route.data as { sessionID: string }).sessionID : undefined}
          keyed
        >
          {(sessionID) => (
            <Prompt
              sessionID={sessionID}
              ref={(ref) => promptRef.set(ref)}
              placeholders={{ normal: ["Ask anything"] }}
            />
          )}
        </Show>
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
        <ExitProvider exit={(reason) => void exits.push(reason ?? "exit")}>
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
  const frame = () => app.captureCharFrame()
  lastFrame = frame
  await wait(() => frame().includes("Ask anything") && frame().includes(`@route session ${target}`))
  // The tool waits on an approval: asked as the server asks it.
  if (input.pending)
    events.emit({
      directory,
      project: "proj_test",
      payload: { id: "evt_per_1", type: "permission.asked", properties: permission },
    } as any)
  await Bun.sleep(100)
  const settle = () => Bun.sleep(80)
  return {
    frame,
    calls,
    exits,
    route: () => route.data,
    toast: () => toast.currentToast?.message,
    status(type: "idle" | "busy") {
      events.emit({
        directory,
        project: "proj_test",
        payload: {
          id: `evt_status_${type}`,
          type: "session.status",
          properties: { sessionID: target, status: { type } },
        },
      } as any)
    },
    async send(text: string) {
      await app.mockInput.typeText(text)
      await settle()
      app.mockInput.pressEnter()
      await settle()
    },
    async key(name: string, modifiers?: { ctrl?: boolean }) {
      app.mockInput.pressKey(name, modifiers)
      await settle()
    },
    async arrow(direction: "left" | "right") {
      app.mockInput.pressArrow(direction)
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
      for (let i = 0; i < 2; i++) {
        app.mockInput.pressEscape()
        await Bun.sleep(20)
      }
      await Bun.sleep(50)
      app.renderer.destroy()
      void tmp[Symbol.asyncDispose]()
    },
  }
}

const posts = (ui: { calls: Call[] }, pattern: RegExp) => ui.calls.filter((call) => pattern.test(call.path))
const LABEL = { claude: "Claude Code", codex: "Codex CLI" } as const

test("the words: exit / quit / :q / /exit close an external session, /exit:lunos quits; elsewhere they quit", () => {
  for (const text of ["exit", "quit", ":q", " exit ", "/exit", "/quit", "/q"])
    expect(exitIntent(text, true)).toBe("close")
  for (const text of ["exit", "quit", ":q"]) expect(exitIntent(text, false)).toBe("quit")
  expect(exitIntent("/exit:lunos", true)).toBe("quit")
  expect(exitIntent("/exit:lunos", false)).toBe("quit")
  // A slash command outside an external session is the app's /exit (the command), not the prompt's.
  expect(exitIntent("/exit", false)).toBeUndefined()
  for (const text of ["exit now", "please quit", "/exit-plan", "q"]) expect(exitIntent(text, true)).toBeUndefined()
  expect(closedMessage("claude", "fix-auth")).toBe('Closed Claude Code session "fix-auth" · /claude to continue')
  expect(closedMessage("codex", undefined)).toBe("Closed Codex CLI session · /codex to continue")
  expect(runningMessage(2)).toBe("2 Claude Code / Codex sessions are running. Stop them and quit?")
  expect(runningMessage(1)).toBe("1 Claude Code / Codex session is running. Stop it and quit?")
})

for (const tool of ["claude", "codex"] as const) {
  describe(`${LABEL[tool]} session, idle`, () => {
    for (const form of ["exit", "quit", ":q", "/exit", "ctrl+d", "ctrl+c", "<leader>q"] as const)
      test(`${form} closes it and returns to the Lunos session; Lunos keeps running`, async () => {
        const ui = await mount({ tool })
        try {
          expect(ui.frame()).toContain("exit closes · /exit:lunos quits Lunos")
          // The longest left side there is: it gives way, the hint and the commands stay whole.
          expect(ui.frame()).toContain("Lunos bridge: off (needs")
          const footer = ui
            .frame()
            .split("\n")
            .find((line) => line.includes("exit closes"))
          expect(footer).toMatch(/Lunos bridge: off .*exit closes · \/exit:lunos quits Lunos +(ctrl\+p )?commands$/)
          if (form === "ctrl+d" || form === "ctrl+c") await ui.key(form.slice(-1), { ctrl: true })
          else if (form === "<leader>q") {
            await ui.key("x", { ctrl: true })
            await ui.key("q")
          } else await ui.send(form)
          await wait(() => ui.frame().includes("@route session ses_lunos"))
          expect(ui.toast()).toBe(closedMessage(tool, "fix-auth"))
          expect(ui.exits).toEqual([])
          // Idle: no tool process runs between turns, so nothing is stopped; the session stays for Continue.
          expect(posts(ui, /abort$/)).toEqual([])
          expect(posts(ui, /\/session\/ses_ext\/(message|prompt|command)/)).toEqual([])
          // Back in a Lunos view, exit quits Lunos again.
          expect(ui.frame()).not.toContain("exit closes")
          await ui.send("exit")
          await wait(() => ui.exits.length === 1)
        } finally {
          await ui.cleanup()
        }
      })
  })
}

describe("Claude Code session, working", () => {
  test("ctrl+c interrupts without closing; ctrl+c again once idle closes", async () => {
    const ui = await mount({ tool: "claude", busy: true })
    try {
      await ui.key("c", { ctrl: true })
      await wait(() => posts(ui, /\/session\/ses_ext\/abort$/).length === 1)
      expect(ui.frame()).toContain("@route session ses_ext")
      expect(ui.toast()).toContain("Interrupted Claude Code")
      expect(ui.exits).toEqual([])
      // The turn ends (as the server reports it); the next ctrl+c closes.
      ui.status("idle")
      await Bun.sleep(80)
      await ui.key("c", { ctrl: true })
      await wait(() => ui.frame().includes("@route session ses_lunos"))
      expect(posts(ui, /abort$/)).toHaveLength(1)
      expect(ui.exits).toEqual([])
    } finally {
      await ui.cleanup()
    }
  })

  test("exit asks; Keep working does nothing; Stop and close refuses the pending approval, stops, closes", async () => {
    const ui = await mount({ tool: "claude", busy: true, pending: true })
    try {
      await ui.send("exit")
      await wait(() => ui.frame().includes("Claude Code is working"))
      expect(ui.frame()).toContain("Stop and close?")
      expect(ui.frame()).toContain("Keep working")
      // Keep working: → selects it, Enter.
      await ui.arrow("right")
      await ui.enter()
      await wait(() => !ui.frame().includes("Claude Code is working"))
      expect(ui.calls).toEqual([])
      expect(ui.frame()).toContain("@route session ses_ext")

      await ui.send("exit")
      await wait(() => ui.frame().includes("Claude Code is working"))
      await ui.enter()
      await wait(() => ui.frame().includes("@route session ses_lunos"))
      const reply = posts(ui, /^\/permission\/per_1\/reply$/)
      expect(reply.map((call) => call.body)).toEqual([{ reply: "reject", message: "Session closed" }])
      expect(posts(ui, /\/session\/ses_ext\/abort$/)).toHaveLength(1)
      // The refusal goes first, so the tool isn't left waiting on it.
      expect(ui.calls.findIndex((call) => call.path.endsWith("/reply"))).toBeLessThan(
        ui.calls.findIndex((call) => call.path.endsWith("/abort")),
      )
      expect(ui.toast()).toBe(closedMessage("claude", "fix-auth"))
      expect(ui.exits).toEqual([])
    } finally {
      await ui.cleanup()
    }
  })

  test("ctrl+d asks the same question instead of interrupting", async () => {
    const ui = await mount({ tool: "claude", busy: true })
    try {
      await ui.key("d", { ctrl: true })
      await wait(() => ui.frame().includes("Claude Code is working"))
      expect(ui.calls).toEqual([])
    } finally {
      await ui.cleanup()
    }
  })
})

describe("quitting Lunos from an external session", () => {
  test("/exit:lunos quits at once when the tool is idle", async () => {
    const ui = await mount({ tool: "codex" })
    try {
      await ui.send("/exit:lunos")
      await wait(() => ui.exits.length === 1)
      expect(ui.calls).toEqual([])
    } finally {
      await ui.cleanup()
    }
  })

  test("with a tool working it asks once; Cancel keeps Lunos, Stop and quit stops it before quitting", async () => {
    const ui = await mount({ tool: "codex", busy: true })
    try {
      await ui.send("/exit:lunos")
      await wait(() => ui.frame().includes("1 Claude Code / Codex session is running"))
      await ui.arrow("right")
      await ui.enter()
      await wait(() => !ui.frame().includes("1 Claude Code / Codex session is running"))
      expect(ui.exits).toEqual([])
      expect(ui.calls).toEqual([])

      await ui.send("/exit:lunos")
      await wait(() => ui.frame().includes("Stop and quit"))
      await ui.enter()
      await wait(() => ui.exits.length === 1)
      expect(posts(ui, /\/session\/ses_ext\/abort$/)).toHaveLength(1)
    } finally {
      await ui.cleanup()
    }
  })
})

describe("a Lunos session: unchanged", () => {
  for (const form of ["exit", "quit", ":q", "/exit", "ctrl+d", "ctrl+c"] as const)
    test(`${form} quits Lunos`, async () => {
      const ui = await mount({})
      try {
        expect(ui.frame()).not.toContain("exit closes")
        if (form === "ctrl+d" || form === "ctrl+c") await ui.key(form.slice(-1), { ctrl: true })
        else await ui.send(form)
        await wait(() => ui.exits.length === 1)
        expect(ui.frame()).toContain("@route session ses_lunos")
        expect(ui.calls).toEqual([])
      } finally {
        await ui.cleanup()
      }
    })
})

test("leaving a session goes back past every visit to it, to the view before; home when there is none", async () => {
  const { RouteProvider, useRoute } = await import("../../src/context/route")
  let route!: ReturnType<typeof useRoute>
  function Grab() {
    route = useRoute()
    return <text>route</text>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <RouteProvider>
          <Grab />
        </RouteProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 5 },
  )
  try {
    const go = (sessionID: string) => route.navigate({ type: "session", sessionID })
    route.navigate({ type: "plugin", id: "monitor", data: { from: { type: "home" } } })
    go("ext1")
    go("lunos")
    go("ext1")
    go("ext1") // a new prompt on the same view isn't a visit
    go("ext2")
    route.leave("ext2")
    expect(route.data).toMatchObject({ type: "session", sessionID: "ext1" })
    // Closing ext1 skips its earlier visit too, and never goes back into ext2, which was closed.
    route.leave("ext1")
    expect(route.data).toMatchObject({ type: "session", sessionID: "lunos" })
    go("ext1")
    route.leave("ext1")
    expect(route.data).toMatchObject({ type: "session", sessionID: "lunos" })
    // ext1's visits are forgotten: leaving lunos goes to the monitor, not back into ext1.
    route.leave("lunos")
    expect(route.data).toEqual({ type: "plugin", id: "monitor", data: { from: { type: "home" } } })
    route.leave("none")
    expect(route.data).toEqual({ type: "home" })
  } finally {
    app.renderer.destroy()
  }
})
