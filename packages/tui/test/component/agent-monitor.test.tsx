/** @jsxImportSource @opentui/solid */
// XCOD-262: the Agent Monitor, driven by keys in a headless 120x45 terminal against a fake server
// that keeps state: the rail's sections, inline approve / deny, a new session, `@n` and `@name`
// tags, the queue, multi-send, delivery to another Lunos and take-over. The opening rules (← on an
// empty prompt) are tested on the prompt itself, with the `agent.monitor` command recorded.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import type { SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

let lastFrame: (() => string) | undefined
async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for condition${lastFrame ? `; screen:\n${lastFrame()}` : ""}`)
    await Bun.sleep(10)
  }
}

const NOW = Date.now()

function row(id: string, extra: Partial<SessionOverviewItem> = {}): SessionOverviewItem {
  return {
    id,
    kind: "session",
    title: `title ${id}`,
    directory: "/work/alpha",
    project: { id: "proj_a", name: "alpha", worktree: "/work/alpha" },
    cost: 0,
    created: 1,
    updated: NOW,
    state: "finished",
    permissions: 0,
    questions: 0,
    ...extra,
  }
}

/**
 * Every kind of row, numbered in rail order: Waiting (1 here, 2 in another Lunos), Running (3 with
 * its subagent 4, 5 in another Lunos, 6 Claude Code), Completed (7 whose Lunos stopped mid-turn, 8),
 * Failed (9), and one completed two days ago behind "Show older".
 */
const fixture = () => [
  row("w1", { state: "waiting", permissions: 1, updated: NOW - 1000 }),
  row("p2", {
    state: "waiting",
    permissions: 1,
    elsewhere: true,
    updated: NOW - 2000,
    project: { id: "proj_b", name: "beta", worktree: "/work/beta" },
    directory: "/work/beta",
  }),
  row("r1", { state: "running", updated: NOW - 3000 }),
  row("sub1", { state: "running", kind: "subagent", parentID: "r1", updated: NOW - 3500 }),
  row("e1", { state: "running", elsewhere: true, updated: NOW - 4000 }),
  row("s1", { state: "idle", stale: true, updated: NOW - 5000 }),
  row("external:cc", {
    kind: "external",
    tool: "claude",
    state: "running",
    title: "Claude Code api",
    updated: NOW - 6000,
  }),
  row("f1", { updated: NOW - 7000 }),
  row("x1", { state: "failed", updated: NOW - 8000 }),
  row("old1", { updated: NOW - 2 * 24 * 60 * 60 * 1000 }),
]

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

type Call = { path: string; body?: any }

/** A fake server: the overview, the waiting sessions' asks, and every route the monitor sends to. */
function fakeServer(input: { sessions: SessionOverviewItem[]; extra?: (url: URL) => Response | undefined }) {
  const sessions = input.sessions
  const calls: Call[] = []
  const permissions = [
    { id: "per_1", sessionID: "w1", permission: "bash", patterns: ["git push origin main"], metadata: {}, always: [] },
  ]
  const peerAsks = {
    permissions: [
      { id: "per_2", sessionID: "p2", permission: "edit", patterns: ["src/a.ts"], metadata: {}, always: [] },
    ],
    questions: [],
  }
  const handler = async (url: URL, request: Request) => {
    const extra = input.extra?.(url)
    if (extra) return extra
    const method = request.method
    if (url.pathname === "/experimental/session-overview") return json({ groups: [], sessions })
    if (url.pathname === "/config/providers") return json({ providers: [PROVIDER], default: { fake: "fake-1" } })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/permission" && method === "GET")
      return json(permissions.filter((item) => sessions.some((each) => each.id === item.sessionID)))
    if (url.pathname === "/question" && method === "GET") return json([])
    if (url.pathname === "/experimental/peer/p2/asks") return json(peerAsks)
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json([])
    if (method !== "POST") return undefined
    const text = await request.clone().text()
    const call: Call = { path: url.pathname, ...(text ? { body: JSON.parse(text) } : {}) }
    if (url.pathname === "/session") {
      calls.push(call)
      const id = `new${calls.filter((each) => each.path === "/session").length}`
      sessions.push(row(id, { state: "running", title: "New session", directory: call.body?.directory }))
      return json({
        id,
        slug: id,
        projectID: "proj_a",
        directory: call.body?.directory,
        title: "New session",
        version: "1",
        time: { created: 1, updated: 1 },
      })
    }
    if (/^\/experimental\/(session|peer)\/[^/]+\/(enqueue|prompt)$/.test(url.pathname)) {
      calls.push(call)
      const id = url.pathname.split("/")[3]
      const busy = sessions.find((each) => each.id === id)?.state === "running"
      return json({ delivery: busy ? (call.body?.interrupt ? "interrupted" : "queued") : "now" })
    }
    if (
      url.pathname.startsWith("/experimental/peer/") ||
      /^\/(permission|question)\/[^/]+\/(reply|reject)$/.test(url.pathname) ||
      /^\/session\/[^/]+\/abort$/.test(url.pathname)
    ) {
      calls.push(call)
      return json(true)
    }
    return undefined
  }
  return { sessions, calls, handler }
}

type Contexts = typeof import("../../src/keymap") & typeof import("../../src/context/route")

async function mount(input: {
  server: ReturnType<typeof fakeServer>
  view: "monitor" | ((modules: Contexts) => JSX.Element)
  config?: Record<string, unknown>
  ready?: (frame: string) => boolean
}) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const base = createFetch(undefined, events)
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const handled = await input.server.handler(new URL(req.url), req)
    return handled ?? base.fetch(req)
  }) as typeof globalThis.fetch

  const [
    { ArgsProvider },
    { KVProvider },
    { ToastProvider, useToast },
    route,
    { TuiConfigProvider },
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
    { PromptRefProvider },
    { EditorContextProvider },
    { LocationProvider },
    { ExitProvider },
    { ClipboardProvider },
    keymapModule,
    { AgentMonitor },
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
    import("../../src/routes/monitor"),
  ])
  const { OpencodeKeymapProvider, registerOpencodeKeymap } = keymapModule
  const { RouteProvider } = route

  let toast!: ReturnType<typeof useToast>
  function Gate() {
    const sync = useSync()
    toast = useToast()
    const [ready, setReady] = createSignal(false)
    // The app's bootstrap has the providers and agents before a prompt is shown.
    onMount(() => void wait(() => sync.status !== "loading").then(() => setReady(true)))
    return (
      <Show when={ready()}>
        {input.view === "monitor" ? (
          <AgentMonitor params={{ from: { type: "home" } }} />
        ) : (
          input.view({ ...keymapModule, ...route })
        )}
      </Show>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000, ...input.config })
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
                                                    <Gate />
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
  await wait(() => (input.ready ?? ((value) => value.includes("Agent Monitor") && value.includes("title w1")))(frame()))
  const settle = () => Bun.sleep(80)
  return {
    app,
    frame,
    calls: input.server.calls,
    toast: () => toast.currentToast?.message,
    async type(text: string) {
      await app.mockInput.typeText(text)
      await settle()
    },
    async enter(modifiers?: { ctrl?: boolean }) {
      app.mockInput.pressEnter(modifiers)
      await settle()
    },
    async tab() {
      app.mockInput.pressTab()
      await settle()
    },
    async key(name: string, modifiers?: { ctrl?: boolean; shift?: boolean; meta?: boolean }) {
      app.mockInput.pressKey(name, modifiers)
      await settle()
    },
    async arrow(direction: "up" | "down" | "left" | "right") {
      app.mockInput.pressArrow(direction)
      await settle()
    },
    async escape() {
      app.mockInput.pressEscape()
      await settle()
    },
    /** Sends what is typed, as Enter does. */
    async send(text: string) {
      await app.mockInput.typeText(text)
      await settle()
      app.mockInput.pressEnter()
      await settle()
    },
    async cleanup() {
      // The prompt keeps unsent text for the next prompt it mounts (as on a route change): Esc twice
      // clears it, so one test's leftovers don't reach the next.
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

const monitor = (sessions = fixture()) => mount({ server: fakeServer({ sessions }), view: "monitor" })
const posts = (ui: { calls: Call[] }, pattern: RegExp) => ui.calls.filter((call) => pattern.test(call.path))

test("the rail: Waiting first with the ask, then Running, Completed and Failed, each counted and numbered", async () => {
  const ui = await monitor()
  try {
    await wait(() => ui.frame().includes("approve: bash git push origin main"))
    const screen = ui.frame()
    const order = ["Waiting for you (2)", "Running (3)", "Completed (2)", "Failed (1)", "Show older (1)"].map((text) =>
      screen.indexOf(text),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    // Numbered in rail order; the subagent sits under its parent, Running because it runs.
    for (const [n, id] of [
      [1, "w1"],
      [2, "p2"],
      [3, "r1"],
      [5, "e1"],
      [7, "s1"],
      [8, "f1"],
      [9, "x1"],
    ] as const)
      expect(screen).toMatch(new RegExp(`\\b${n} . title ${id}\\b`))
    expect(screen).toMatch(/↳ 4 . title sub1/)
    // Another Lunos's ask comes from that Lunos.
    expect(screen).toContain("approve: edit src/a.ts")
    expect(screen).not.toContain("title old1")
    // NO_COLOR: the state glyph carries the meaning, not colour alone.
    expect(screen).toMatch(/1 ! title w1/)
  } finally {
    await ui.cleanup()
  }
})

test("a / d answer the shown ask inline: here through the permission route, in another Lunos through peer", async () => {
  const ui = await monitor()
  try {
    await wait(() => ui.frame().includes("approve: edit src/a.ts"))
    await ui.tab()
    await wait(() => ui.frame().includes("a approve · d deny"))
    await ui.key("a")
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({ path: "/permission/per_1/reply", body: { reply: "once" } })
    await wait(() => ui.toast() === "Approved: approve: bash git push origin main")
    // The next session waiting for you is highlighted: the one in another Lunos.
    await ui.key("d")
    await wait(() => ui.calls.length === 2)
    expect(ui.calls[1]).toEqual({ path: "/experimental/peer/p2/permission/per_2/reply", body: { reply: "reject" } })
  } finally {
    await ui.cleanup()
  }
})

test("an untagged prompt starts a session in the project, with the default agent and model; the monitor stays", async () => {
  const ui = await monitor()
  try {
    await ui.send("write the release notes")
    await wait(() => posts(ui, /enqueue$/).length === 1)
    const created = posts(ui, /^\/session$/)
    expect(created).toHaveLength(1)
    expect(created[0]!.body).toMatchObject({ agent: "build", model: { providerID: "fake", id: "fake-1" } })
    expect(posts(ui, /enqueue$/)[0]).toEqual({
      path: "/experimental/session/new1/enqueue",
      body: { text: "write the release notes", model: { providerID: "fake", modelID: "fake-1" } },
    })
    await wait(() => ui.frame().includes("New session"))
    expect(ui.frame()).toContain("Agent Monitor")
    expect(ui.frame()).toContain("Running (4)")
  } finally {
    await ui.cleanup()
  }
})

test("@n sends to session n; a running one queues it, and ctrl+enter interrupts and sends now", async () => {
  const ui = await monitor()
  try {
    await ui.send("@3 run the tests")
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({
      path: "/experimental/session/r1/enqueue",
      body: { text: "run the tests", interrupt: false },
    })
    await wait(() => ui.toast() === 'Queued for "title r1"')

    await ui.type("@3 stop and fix the build")
    await ui.enter({ ctrl: true })
    await wait(() => ui.calls.length === 2)
    expect(ui.calls[1]!.body).toEqual({ text: "stop and fix the build", interrupt: true })

    // An idle session runs it now; an unknown number sends nothing.
    await ui.send("@8 one more thing")
    await wait(() => ui.calls.length === 3)
    expect(ui.calls[2]!.path).toBe("/experimental/session/f1/enqueue")
    await ui.send("@42 hello")
    await wait(() => ui.toast() === "No session @42 in the rail")
    expect(ui.calls).toHaveLength(3)
  } finally {
    await ui.cleanup()
  }
})

test("@ and a name autocompletes sessions; the pick becomes its number", async () => {
  const ui = await monitor()
  try {
    // A space ends a mention, so a name is typed as one word: "@f1" for "title f1".
    await ui.type("@f1")
    await wait(() => ui.frame().includes("@8 title f1"))
    await ui.enter()
    await wait(() => ui.frame().includes("To: @8 title f1"))
    await ui.send("summarise it")
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({
      path: "/experimental/session/f1/enqueue",
      body: { text: "summarise it", interrupt: false },
    })
  } finally {
    await ui.cleanup()
  }
})

test("tagging three sessions asks first; Esc sends nothing, confirming sends to each", async () => {
  const ui = await monitor()
  try {
    await ui.send("@3 @8 @9 rebase on dev")
    await wait(() => ui.frame().includes("Send to 3 sessions?"))
    await ui.escape()
    await Bun.sleep(100)
    expect(ui.calls).toHaveLength(0)

    // What was typed is still there: Enter asks again.
    await ui.enter()
    await wait(() => ui.frame().includes("Send to 3 sessions?"))
    await ui.enter()
    await wait(() => ui.calls.length === 3)
    expect(ui.calls.map((call) => call.path).toSorted()).toEqual(
      ["r1", "f1", "x1"].map((id) => `/experimental/session/${id}/enqueue`).toSorted(),
    )
    for (const call of ui.calls) expect(call.body.text).toBe("rebase on dev")
    await wait(() => ui.toast() === "Sent to 2, queued for 1")
  } finally {
    await ui.cleanup()
  }
})

test("a session another Lunos runs gets the prompt through peer.prompt, never enqueued here", async () => {
  const ui = await monitor()
  try {
    await ui.send("@5 check the logs")
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({
      path: "/experimental/peer/e1/prompt",
      body: { text: "check the logs", interrupt: false },
    })
    await Bun.sleep(100)
    expect(posts(ui, /enqueue$/)).toHaveLength(0)
  } finally {
    await ui.cleanup()
  }
})

test("a session whose Lunos stopped asks to take it over first", async () => {
  const ui = await monitor()
  try {
    await ui.send("@7 carry on")
    await wait(() => ui.frame().includes("Take over this session here?"))
    await ui.escape()
    await Bun.sleep(100)
    expect(ui.calls).toHaveLength(0)

    await ui.enter()
    await wait(() => ui.frame().includes("Take over this session here?"))
    await ui.enter()
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({
      path: "/experimental/session/s1/enqueue",
      body: { text: "carry on", interrupt: false },
    })
  } finally {
    await ui.cleanup()
  }
})

test("a prompt never approves a tool call: tagged to a session waiting on one, only the prompt is sent", async () => {
  const ui = await monitor()
  try {
    await ui.send("@1 yes, go ahead")
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]!.path).toBe("/experimental/session/w1/enqueue")
    await ui.send("@2 yes, go ahead")
    await wait(() => ui.calls.length === 2)
    expect(ui.calls[1]!.path).toBe("/experimental/peer/p2/prompt")
    await Bun.sleep(100)
    expect(posts(ui, /permission/)).toHaveLength(0)
    // A Claude Code session with no Lunos session isn't sent anything from here.
    await ui.send("@6 hi")
    await wait(() => ui.toast()?.includes("open it to send it a prompt") === true)
    expect(ui.calls).toHaveLength(2)
  } finally {
    await ui.cleanup()
  }
})

/** The prompt on home, or on a session, with `agent.monitor` (what ← dispatches) recorded. */
async function promptOn(input: {
  route?: { type: "session"; sessionID: string }
  sessions?: unknown[]
  config?: Record<string, unknown>
}) {
  const opened: string[] = []
  const server = fakeServer({
    sessions: [],
    extra: (url) => (url.pathname === "/session" && input.sessions ? json(input.sessions) : undefined),
  })
  const { Prompt } = await import("../../src/component/prompt")
  const ui = await mount({
    server,
    config: input.config,
    ready: (frame) => frame.includes("Ask anything"),
    view: (modules) => {
      const route = modules.useRoute()
      if (input.route) route.navigate(input.route)
      modules.useBindings(() => ({
        commands: [{ name: "agent.monitor", title: "Agent Monitor", run: () => void opened.push(route.data.type) }],
      }))
      return <Prompt sessionID={input.route?.sessionID} placeholders={{ normal: ["Ask anything"] }} />
    },
  })
  return { ...ui, opened }
}

test("opening: ← on an empty prompt opens the monitor; with text it moves the cursor", async () => {
  const ui = await promptOn({})
  try {
    await ui.arrow("left")
    await wait(() => ui.opened.length === 1)
    expect(ui.opened).toEqual(["home"])
    await ui.type("ab")
    await ui.arrow("left")
    await ui.type("X")
    await wait(() => ui.frame().includes("aXb"))
    expect(ui.opened).toHaveLength(1)
  } finally {
    await ui.cleanup()
  }
})

test('opening: ← does nothing new with "left_opens_monitor": false, or in a subagent session', async () => {
  const off = await promptOn({ config: { left_opens_monitor: false } })
  try {
    await off.arrow("left")
    await Bun.sleep(150)
    expect(off.opened).toHaveLength(0)
  } finally {
    await off.cleanup()
  }
  const child = {
    id: "ses_child",
    slug: "child",
    projectID: "proj_test",
    directory,
    parentID: "ses_parent",
    title: "child",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  const ui = await promptOn({ route: { type: "session", sessionID: "ses_child" }, sessions: [child] })
  try {
    await Bun.sleep(150)
    await ui.arrow("left")
    await Bun.sleep(150)
    expect(ui.opened).toHaveLength(0)
  } finally {
    await ui.cleanup()
  }
})
