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
 * Every kind of row, numbered in rail order (XCOD-299): Working (1 with its subagent 2, 3 in another
 * Lunos, 4 Claude Code), Waiting for action (5 here, 6 in another Lunos), Completed (7 failed first,
 * then 8 whose Lunos stopped mid-turn, 9), and one completed two days ago behind "Show older".
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
function fakeServer(input: {
  sessions: SessionOverviewItem[]
  extra?: (url: URL, request: Request) => Response | undefined | Promise<Response | undefined>
}) {
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
    const extra = await input.extra?.(url, request)
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
    if (/^\/experimental\/session\/[^/]+\/takeover$/.test(url.pathname)) {
      calls.push(call)
      return json({
        sent: call.body?.queued === "send" ? 2 : 0,
        discarded: call.body?.queued === "discard" ? 2 : 0,
        ...(call.body?.text ? { delivery: "now" } : {}),
      })
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
  /** XCOD-307: the terminal width (120 by default), and what kv.json starts with. */
  width?: number
  kv?: Record<string, unknown>
}) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify(input.kv ?? {}))
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

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: input.width ?? 120, height: 45 })
  const frame = () => app.captureCharFrame()
  lastFrame = frame
  await wait(() => (input.ready ?? ((value) => value.includes("Agent Monitor") && value.includes("title w1")))(frame()))
  const settle = () => Bun.sleep(80)
  return {
    app,
    frame,
    calls: input.server.calls,
    /** Tells the monitor something changed, as the server's events do. */
    poke: () =>
      events.emit({
        directory,
        payload: { type: "session.status", properties: { sessionID: "w1", status: { type: "busy" } } },
      } as never),
    kv: () => Bun.file(path.join(state, "kv.json")).json(),
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

test("the rail: Working, Waiting for action with the ask, then Completed (failed first), each counted and numbered", async () => {
  const ui = await monitor()
  try {
    await wait(() => ui.frame().includes("approve: bash git push origin main"))
    const screen = ui.frame()
    const order = ["▼ Working (4)", "▼ Waiting for action (2)", "▼ Completed (3)", "Show older (1)"].map((text) =>
      screen.indexOf(text),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    // Numbered in rail order; the subagent sits under its parent, in Working because it runs.
    for (const [n, id] of [
      [1, "r1"],
      [3, "e1"],
      [5, "w1"],
      [6, "p2"],
      [7, "x1"],
      [8, "s1"],
      [9, "f1"],
    ] as const)
      expect(screen).toMatch(new RegExp(`\\b${n} . title ${id}\\b`))
    expect(screen).toMatch(/↳ 2 . title sub1/)
    // Completed: the failed one first.
    expect(screen.indexOf("title x1")).toBeLessThan(screen.indexOf("title s1"))
    // Another Lunos's ask comes from that Lunos.
    expect(screen).toContain("approve: edit src/a.ts")
    expect(screen).not.toContain("title old1")
    // NO_COLOR: the state glyph carries the meaning, not colour alone.
    expect(screen).toMatch(/5 ! title w1/)
    expect(screen).toMatch(/7 ✕ title x1/)
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
    // From the first row (title r1) down across Working's rows and Waiting for action's header.
    for (let i = 0; i < 5; i++) await ui.arrow("down")
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
    expect(ui.frame()).toContain("Working (5)")
  } finally {
    await ui.cleanup()
  }
})

test("@n sends to session n; a running one queues it, and ctrl+enter interrupts and sends now", async () => {
  const ui = await monitor()
  try {
    await ui.send("@1 run the tests")
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({
      path: "/experimental/session/r1/enqueue",
      body: { text: "run the tests", interrupt: false },
    })
    await wait(() => ui.toast() === 'Queued for "title r1"')

    await ui.type("@1 stop and fix the build")
    await ui.enter({ ctrl: true })
    await wait(() => ui.calls.length === 2)
    expect(ui.calls[1]!.body).toEqual({ text: "stop and fix the build", interrupt: true })

    // An idle session runs it now; an unknown number sends nothing.
    await ui.send("@9 one more thing")
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
    await wait(() => ui.frame().includes("@9 title f1"))
    await ui.enter()
    await wait(() => ui.frame().includes("To: @9 title f1"))
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
    await ui.send("@1 @9 @7 rebase on dev")
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
    await ui.send("@3 check the logs")
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
    await ui.send("@8 carry on")
    await wait(() => ui.frame().includes("Take over this session here?"))
    await ui.escape()
    await Bun.sleep(100)
    expect(ui.calls).toHaveLength(0)

    await ui.enter()
    await wait(() => ui.frame().includes("Take over this session here?"))
    await ui.enter()
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]).toEqual({
      path: "/experimental/session/s1/takeover",
      body: { queued: "send", text: "carry on" },
    })
  } finally {
    await ui.cleanup()
  }
})

test("XCOD-262: prompts a closed Lunos queued show on the row, and go only with the take-over the user picks", async () => {
  const sessions = () => [
    row("w1", { state: "waiting", permissions: 1, updated: NOW - 1000 }),
    row("q1", { state: "idle", queued: 2, ownerClosed: true, updated: NOW - 2000 }),
  ]
  for (const [choice, keys] of [
    ["send", []],
    ["discard", ["down"]],
  ] as const) {
    const ui = await monitor(sessions())
    try {
      await wait(() => ui.frame().includes("2 queued (owner closed)"))
      await ui.send("@2 carry on")
      await wait(() => ui.frame().includes("closed with 2 prompts queued"))
      expect(ui.frame()).toContain("Take over, send the 2 queued prompts first")
      expect(ui.frame()).toContain("Take over, discard all 2")
      for (const key of keys) await ui.arrow(key)
      await ui.enter()
      await wait(() => ui.calls.length === 1)
      // Never enqueued directly: the take-over carries the prompt, behind the queued ones.
      expect(ui.calls[0]).toEqual({
        path: "/experimental/session/q1/takeover",
        body: { queued: choice, text: "carry on" },
      })
    } finally {
      await ui.cleanup()
    }
  }
  // Cancel sends nothing, and takes nothing over.
  const ui = await monitor(sessions())
  try {
    await ui.send("@2 carry on")
    await wait(() => ui.frame().includes("closed with 2 prompts queued"))
    await ui.escape()
    await Bun.sleep(100)
    expect(ui.calls).toHaveLength(0)
  } finally {
    await ui.cleanup()
  }
})

test("XCOD-268: t takes over a closed Lunos's queued prompts with no new prompt; only offered on such rows", async () => {
  const sessions = () => [
    row("w1", { state: "waiting", permissions: 1, updated: NOW - 1000 }),
    row("q1", { state: "idle", queued: 2, ownerClosed: true, updated: NOW - 2000 }),
  ]
  for (const [choice, keys, toast] of [
    ["send", [], 'Took over "title q1": sending its 2 queued prompts'],
    ["discard", ["down"], 'Took over "title q1": discarded its 2 queued prompts'],
  ] as const) {
    const ui = await monitor(sessions())
    try {
      await wait(() => ui.frame().includes("2 queued (owner closed)"))
      await ui.tab()
      await wait(() => ui.frame().includes("a approve · d deny"))
      // The waiting row has nothing queued: no hint, and t does nothing.
      expect(ui.frame()).not.toContain("t take over")
      await ui.key("t")
      await Bun.sleep(100)
      expect(ui.frame()).not.toContain("Take over this session here?")
      // Past Completed's header to its row.
      await ui.arrow("down")
      await ui.arrow("down")
      await wait(() => ui.frame().includes("t take over"))
      await ui.key("t")
      await wait(() => ui.frame().includes("closed with 2 prompts queued"))
      expect(ui.frame()).toContain("Send 2 queued prompts")
      expect(ui.frame()).toContain("Discard them")
      expect(ui.frame()).toContain("Cancel")
      for (const key of keys) await ui.arrow(key)
      await ui.enter()
      await wait(() => ui.calls.length === 1)
      // No text: only the queued prompts move, through the same take-over.
      expect(ui.calls[0]).toEqual({ path: "/experimental/session/q1/takeover", body: { queued: choice } })
      await wait(() => ui.toast() === toast)
    } finally {
      await ui.cleanup()
    }
  }
  // Cancel takes nothing over.
  const ui = await monitor(sessions())
  try {
    await wait(() => ui.frame().includes("2 queued (owner closed)"))
    await ui.tab()
    await ui.arrow("down")
    await ui.arrow("down")
    await wait(() => ui.frame().includes("t take over"))
    await ui.key("t")
    await wait(() => ui.frame().includes("closed with 2 prompts queued"))
    await ui.escape()
    await Bun.sleep(100)
    expect(ui.calls).toHaveLength(0)
  } finally {
    await ui.cleanup()
  }
}, 20_000)

test("a prompt never approves a tool call: tagged to a session waiting on one, only the prompt is sent", async () => {
  const ui = await monitor()
  try {
    await ui.send("@5 yes, go ahead")
    await wait(() => ui.calls.length === 1)
    expect(ui.calls[0]!.path).toBe("/experimental/session/w1/enqueue")
    await ui.send("@6 yes, go ahead")
    await wait(() => ui.calls.length === 2)
    expect(ui.calls[1]!.path).toBe("/experimental/peer/p2/prompt")
    await Bun.sleep(100)
    expect(posts(ui, /permission/)).toHaveLength(0)
    // A Claude Code session with no Lunos session isn't sent anything from here.
    await ui.send("@4 hi")
    await wait(() => ui.toast()?.includes("open it to send it a prompt") === true)
    expect(ui.calls).toHaveLength(2)
  } finally {
    await ui.cleanup()
  }
})

// XCOD-299: the three sub-sections, by keyboard.
test("XCOD-299: ↑/↓ cross the sub-sections and their headers; Enter collapses one, kept in kv.json; s still stops", async () => {
  const ui = await monitor()
  try {
    await wait(() => ui.frame().includes("approve: bash git push origin main"))
    await ui.tab()
    await wait(() => ui.frame().includes("↑↓ move · enter open"))
    // Up from the first row is Working's header.
    await ui.arrow("up")
    await wait(() => ui.frame().includes("↑↓ move · enter collapse"))
    await ui.enter()
    await wait(() => ui.frame().includes("▶ Working (4) ◐ 4 running"))
    expect(ui.frame()).not.toContain("title r1")
    expect(ui.frame()).not.toContain("Highlighted: @1")
    // Down from the collapsed header goes straight to Waiting for action.
    await ui.arrow("down")
    await ui.arrow("down")
    await wait(() => ui.frame().includes("Highlighted: @5 title w1"))
    // Down past Waiting for action's rows and Completed's header to its first row, then s stops it.
    for (let i = 0; i < 3; i++) await ui.arrow("down")
    await wait(() => ui.frame().includes("Highlighted: @7 title x1"))
    await ui.arrow("up")
    await ui.arrow("up")
    await ui.arrow("up")
    await ui.arrow("up")
    await wait(() => ui.frame().includes("↑↓ move · enter collapse"))
    await ui.arrow("down")
    await wait(() => ui.frame().includes("Highlighted: @5 title w1"))
    await ui.key("s")
    await wait(() => ui.frame().includes("Stop this session?"))
    await ui.enter()
    await wait(() => posts(ui, /abort$/).length === 1)
    expect(posts(ui, /abort$/)[0]!.path).toBe("/session/w1/abort")
    await Bun.sleep(100)
    expect((await ui.kv()).agent_monitor_groups).toEqual({ working: false })
  } finally {
    await ui.cleanup()
  }
})

test("XCOD-299: a collapsed Waiting for action opens again when a new ask arrives", async () => {
  const sessions = fixture()
  const ui = await monitor(sessions)
  try {
    await wait(() => ui.frame().includes("approve: bash git push origin main"))
    await ui.tab()
    // r1, sub1, e1, cc, then Waiting for action's header.
    for (let i = 0; i < 4; i++) await ui.arrow("down")
    await wait(() => ui.frame().includes("↑↓ move · enter collapse"))
    await ui.enter()
    await wait(() => ui.frame().includes("▶ Waiting for action (2) ! 2 waiting"))
    expect(ui.frame()).not.toContain("approve: bash git push origin main")
    // An answered one doesn't open it.
    sessions.splice(
      sessions.findIndex((item) => item.id === "p2"),
      1,
    )
    ui.poke()
    await wait(() => ui.frame().includes("▶ Waiting for action (1)"))
    // A new one does.
    sessions.push(row("n1", { state: "waiting", questions: 1, updated: NOW }))
    ui.poke()
    await wait(() => ui.frame().includes("▼ Waiting for action (2)"))
    expect(ui.frame()).toContain("approve: bash git push origin main")
    await Bun.sleep(100)
    expect((await ui.kv()).agent_monitor_groups ?? {}).toEqual({})
  } finally {
    await ui.cleanup()
  }
})

test("XCOD-299: empty sub-sections show (0), collapsed, in their place", async () => {
  const ui = await mount({
    server: fakeServer({ sessions: [row("f1", { updated: NOW - 7000 })] }),
    view: "monitor",
    ready: (frame) => frame.includes("title f1"),
  })
  try {
    const screen = ui.frame()
    const order = ["▶ Working (0)", "▶ Waiting for action (0)", "▼ Completed (1)"].map((text) => screen.indexOf(text))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    // Enter on an empty header does nothing.
    await ui.tab()
    await ui.arrow("up")
    await ui.arrow("up")
    await ui.enter()
    expect(ui.frame()).toContain("▶ Working (0)")
  } finally {
    await ui.cleanup()
  }
})

/** The prompt on home, or on a session, with `agent.monitor` (what ← dispatches) recorded. */
async function promptOn(input: {
  route?: { type: "session"; sessionID: string }
  sessions?: unknown[]
  config?: Record<string, unknown>
  extra?: (url: URL, request: Request) => Response | undefined | Promise<Response | undefined>
}) {
  const opened: string[] = []
  const server = fakeServer({
    sessions: [],
    extra: (url, request) =>
      url.pathname === "/session" && request.method === "GET" && input.sessions
        ? json(input.sessions)
        : input.extra?.(url, request),
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
  // The control: the same session as a top-level one opens it from the session route.
  const { parentID: _, ...top } = child
  const parent = await promptOn({ route: { type: "session", sessionID: "ses_child" }, sessions: [top] })
  try {
    await Bun.sleep(150)
    await parent.arrow("left")
    await wait(() => parent.opened.length === 1)
    expect(parent.opened).toEqual(["session"])
  } finally {
    await parent.cleanup()
  }
})

// XCOD-267: the full session view asks the same take-over question before the first prompt in a
// session a closed Lunos left prompts queued for; a session without any is sent to as before.
async function sessionView(orphaned: number) {
  const session = {
    id: "ses_q",
    slug: "q",
    projectID: "proj_test",
    directory,
    title: "queued work",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  const sent: Call[] = []
  const ui = await promptOn({
    route: { type: "session", sessionID: "ses_q" },
    sessions: [session],
    extra: async (url, request) => {
      if (url.pathname === "/experimental/session/ses_q/queued") return json({ orphaned })
      if (request.method !== "POST") return undefined
      if (url.pathname === "/experimental/session/ses_q/takeover" || url.pathname === "/session/ses_q/message") {
        const text = await request.clone().text()
        sent.push({ path: url.pathname, ...(text ? { body: JSON.parse(text) } : {}) })
        return json(url.pathname.endsWith("takeover") ? { sent: 2, discarded: 0, delivery: "queued", position: 2 } : {})
      }
      return undefined
    },
  })
  return { ...ui, sent }
}

const typed = { agent: "build", model: { providerID: "fake", modelID: "fake-1" } }

test("XCOD-267: in the session view, a closed Lunos's queued prompts are asked about first; Cancel keeps the text", async () => {
  const ui = await sessionView(2)
  try {
    await Bun.sleep(150)
    await ui.send("carry on")
    await wait(() => ui.frame().includes("closed with 2 prompts queued"))
    expect(ui.frame()).toContain("Take over, send the 2 queued prompts first")
    expect(ui.frame()).toContain("Take over, discard all 2")
    expect(ui.frame()).toContain("Cancel")
    await ui.escape()
    await Bun.sleep(150)
    expect(ui.sent).toHaveLength(0)
    expect(ui.frame()).toContain("carry on")

    // Send them first (the default): the prompt goes with the take-over, as the request the view makes.
    await ui.enter()
    await wait(() => ui.frame().includes("closed with 2 prompts queued"))
    await ui.enter()
    await wait(() => ui.sent.length === 1)
    expect(ui.sent[0]).toEqual({
      path: "/experimental/session/ses_q/takeover",
      body: {
        queued: "send",
        origin: "session",
        text: "carry on",
        request: { kind: "prompt", body: { ...typed, parts: [{ type: "text", text: "carry on" }] } },
      },
    })
    await Bun.sleep(150)
    expect(ui.sent).toHaveLength(1)
    expect(ui.frame()).not.toContain("carry on")
  } finally {
    await ui.cleanup()
  }
}, 20_000)

test("XCOD-267: Discard drops the queued prompts, then the typed one is sent as usual", async () => {
  const ui = await sessionView(2)
  try {
    await Bun.sleep(150)
    await ui.send("start over")
    await wait(() => ui.frame().includes("closed with 2 prompts queued"))
    await ui.arrow("down")
    await ui.enter()
    await wait(() => ui.sent.length === 2)
    expect(ui.sent[0]).toEqual({
      path: "/experimental/session/ses_q/takeover",
      body: { queued: "discard", origin: "session" },
    })
    expect(ui.sent[1]!.path).toBe("/session/ses_q/message")
    expect(ui.sent[1]!.body.parts).toEqual([{ type: "text", text: "start over" }])
  } finally {
    await ui.cleanup()
  }
}, 20_000)

test("XCOD-267: a session with nothing queued by a closed Lunos is sent to with no question", async () => {
  const ui = await sessionView(0)
  try {
    await Bun.sleep(150)
    await ui.send("just go")
    await wait(() => ui.sent.length === 1)
    expect(ui.sent[0]!.path).toBe("/session/ses_q/message")
    expect(ui.frame()).not.toContain("Take over this session here?")
  } finally {
    await ui.cleanup()
  }
}, 20_000)

// XCOD-284: the same Delete as /sessions, on the rail's selected row (x; d is deny there).
test("XCOD-284: x on the rail deletes the selected session after the same confirmation; Cancel keeps it", async () => {
  const sessions = [
    row("w1", { state: "waiting", permissions: 1, updated: NOW - 1000 }),
    row("f1", { updated: NOW - 7000 }),
  ]
  const deletes: Call[] = []
  const server = fakeServer({
    sessions,
    extra: async (url, request) => {
      if (url.pathname === "/experimental/session-bulk/preview") {
        const body = await request.clone().json()
        return json({
          items: body.sessionIDs.map((id: string) => ({ id, messages: 5, children: 0, queued: 0, shared: false })),
          sync: false,
        })
      }
      if (url.pathname === "/experimental/session-bulk/delete") {
        const body = await request.clone().json()
        deletes.push({ path: url.pathname, body })
        for (const id of body.sessionIDs)
          sessions.splice(
            sessions.findIndex((item) => item.id === id),
            1,
          )
        return json({ deleted: body.sessionIDs, skipped: [] })
      }
      return undefined
    },
  })
  const ui = await mount({ server, view: "monitor" })
  // The confirmation wraps: read it with its lines joined (and the dialog's "esc" hint taken out).
  const text = () => ui.frame().replace(/\s+/g, " ").replace(/ esc /g, " ")
  try {
    await ui.tab()
    // (The rail's key hint is cut at this width; "x delete" is in it, after "s stop".)
    await wait(() => ui.frame().includes("↑↓ move · enter open"))
    // Past Completed's header to its row.
    await ui.arrow("down")
    await ui.arrow("down")
    await ui.key("x")
    // (The rail beside the dialog can show through on its first line, so the two are read apart.)
    await wait(
      () =>
        text().includes(`Delete "title f1" (project alpha, 5 messages)?`) && text().includes("This can't be undone."),
    )
    // Cancel is the default.
    await ui.enter()
    await Bun.sleep(100)
    expect(deletes).toHaveLength(0)
    expect(ui.frame()).toContain("title f1")

    await ui.key("x")
    await wait(() => text().includes(`Delete "title f1"`))
    await ui.arrow("down")
    await ui.enter()
    await wait(() => deletes.length === 1)
    expect(deletes[0]!.body).toMatchObject({ sessionIDs: ["f1"], archivedOnly: false, origin: "single" })
    await wait(() => ui.toast() === "Deleted 1 session")
    await wait(() => !ui.frame().includes("title f1"))
  } finally {
    await ui.cleanup()
  }
})

// XCOD-307: hiding the right pane. The session view's pane (`useRightPane`, the » and « controls)
// in a host beside a stand-in conversation that prints its width, and the Agent Monitor's list.
async function paneHost(input: { width: number; kv?: Record<string, unknown>; waiting?: () => number }) {
  const RightPaneUI = await import("../../src/component/right-pane")
  const { useTerminalDimensions } = await import("@opentui/solid")
  const { useTuiConfig } = await import("../../src/config")
  const ui = await mount({
    server: fakeServer({ sessions: [] }),
    width: input.width,
    kv: input.kv,
    ready: (frame) => frame.includes("conversation"),
    view: (modules) => {
      const dimensions = useTerminalDimensions()
      const config = useTuiConfig()
      const pane = RightPaneUI.useRightPane({ key: () => "sidebar", wide: () => dimensions().width > 120 })
      modules.useBindings(() => ({
        commands: [{ namespace: "palette", name: "session.sidebar.toggle", title: "Toggle", run: pane.toggle }],
      }))
      // As the session view binds it.
      modules.useBindings(() => ({
        mode: modules.OPENCODE_BASE_MODE,
        bindings: config.keybinds.gather("session", ["session.sidebar.toggle"]),
      }))
      return (
        <box flexDirection="row" flexGrow={1}>
          <box flexGrow={1}>
            <text>
              conversation {dimensions().width - pane.taken() - 4} cols, pane {pane.placement()}
            </text>
          </box>
          <Show when={!pane.visible()}>
            <RightPaneUI.PaneChip
              count={input.waiting?.() ?? 0}
              label={`${input.waiting?.() ?? 0} waiting for action`}
              onOpen={pane.toggle}
            />
          </Show>
          <Show when={pane.visible()}>
            <box width={42} position={pane.placement() === "overlay" ? "absolute" : "relative"} right={0}>
              <RightPaneUI.PaneHide onHide={pane.toggle} />
            </box>
          </Show>
        </box>
      )
    },
  })
  const click = async (text: string) => {
    const lines = ui.frame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    if (y < 0) throw new Error(`no "${text}" on screen:\n${ui.frame()}`)
    await ui.app.mockMouse.click(lines[y]!.indexOf(text), y)
    await Bun.sleep(80)
  }
  const leader = async (key: string) => {
    await ui.key("x", { ctrl: true })
    await ui.key(key)
  }
  return { ...ui, click, leader }
}

test("XCOD-307: on 160 columns » hides the pane, the conversation takes its 42 columns, « brings it back", async () => {
  const ui = await paneHost({ width: 160 })
  try {
    expect(ui.frame()).toContain("conversation 114 cols, pane docked")
    expect(ui.frame()).toContain("hide pane ctrl+x b »")
    await ui.click("»")
    await wait(() => ui.frame().includes("conversation 156 cols, pane hidden"))
    expect(ui.frame()).toContain("« show pane ctrl+x b")
    expect((await ui.kv()).sidebar).toBe("hide")
    await ui.click("«")
    await wait(() => ui.frame().includes("conversation 114 cols, pane docked"))
    expect((await ui.kv()).sidebar).toBe("auto")
  } finally {
    await ui.cleanup()
  }
}, 20_000)

test("XCOD-307: the keybind does what the buttons do", async () => {
  const ui = await paneHost({ width: 160 })
  try {
    await ui.leader("b")
    await wait(() => ui.frame().includes("pane hidden"))
    expect((await ui.kv()).sidebar).toBe("hide")
    await ui.leader("b")
    await wait(() => ui.frame().includes("pane docked"))
  } finally {
    await ui.cleanup()
  }
}, 20_000)

test("XCOD-307: Hidden is kept across a restart (kv.json); Always show docks even on a narrow terminal", async () => {
  const hidden = await paneHost({ width: 160, kv: { sidebar: "hide" } })
  try {
    expect(hidden.frame()).toContain("pane hidden")
    expect(hidden.frame()).toContain("« show pane")
  } finally {
    await hidden.cleanup()
  }
  const shown = await paneHost({ width: 100, kv: { sidebar: "show" } })
  try {
    expect(shown.frame()).toContain("conversation 54 cols, pane docked")
  } finally {
    await shown.cleanup()
  }
}, 20_000)

test("XCOD-307: Auto on a narrow terminal opens as an overlay, and closing it doesn't save Hidden", async () => {
  const ui = await paneHost({ width: 100 })
  try {
    expect(ui.frame()).toContain("conversation 96 cols, pane hidden")
    await ui.click("«")
    // Over the conversation: its width doesn't change.
    await wait(() => ui.frame().includes("conversation 96 cols, pane overlay"))
    await ui.click("»")
    await wait(() => ui.frame().includes("pane hidden"))
    expect((await ui.kv()).sidebar).toBeUndefined()
  } finally {
    await ui.cleanup()
  }
}, 20_000)

test("XCOD-307: with the pane hidden, a subagent waiting for action puts a badge on « within a second", async () => {
  const [waiting, setWaiting] = createSignal(0)
  const ui = await paneHost({ width: 160, kv: { sidebar: "hide" }, waiting })
  try {
    expect(ui.frame()).not.toContain("need")
    setWaiting(1)
    const start = Date.now()
    await wait(() => ui.frame().includes("● 1 needs you"))
    expect(Date.now() - start).toBeLessThan(1000)
    setWaiting(2)
    await wait(() => ui.frame().includes("● 2 need you"))
    // Opening the pane clears the badge (it's in the pane now).
    await ui.click("«")
    await wait(() => ui.frame().includes("pane docked"))
    expect(ui.frame()).not.toContain("need you")
  } finally {
    await ui.cleanup()
  }
}, 20_000)

test("XCOD-307: the Agent Monitor's list hides with the pane keybind, « shows the waiting count, and it's kept apart", async () => {
  const ui = await mount({ server: fakeServer({ sessions: fixture() }), view: "monitor", width: 160 })
  try {
    expect(ui.frame()).toContain("hide list ctrl+x b »")
    expect(ui.frame()).toContain("Sessions on this computer")
    await ui.key("x", { ctrl: true })
    await ui.key("b")
    await wait(() => !ui.frame().includes("Sessions on this computer"))
    await wait(() => ui.frame().includes("« show sessions ctrl+x b ● 2 need you"))
    const kv = await ui.kv()
    expect(kv.monitor_rail).toBe("hide")
    expect(kv.sidebar).toBeUndefined()
    // Tab doesn't move focus to a hidden list.
    await ui.tab()
    expect(ui.frame()).not.toContain("Sessions on this computer")
    const lines = ui.frame().split("\n")
    const y = lines.findIndex((line) => line.includes("« show sessions"))
    await ui.app.mockMouse.click(lines[y]!.indexOf("«"), y)
    await wait(() => ui.frame().includes("Sessions on this computer"))
    expect((await ui.kv()).monitor_rail).toBe("auto")
  } finally {
    await ui.cleanup()
  }
}, 20_000)
