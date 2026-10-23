/** @jsxImportSource @opentui/solid */
// XCOD-310: model and Manual / Auto approval per session and workflow, the <leader>p key, the
// `Workflow · Approval · model` indicator, workflow defaults from config and the organisation lock.
// Driven by keys in a headless 120x45 terminal against a fake server; the approval decision is the
// one the TUI makes on a `permission.asked` event (answering the ask, or leaving it pending).
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
import { approvalLock, resolveApproval, rootSession } from "../../src/util/approval"

let lastFrame: (() => string) | undefined
async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for condition${lastFrame ? `; screen:\n${lastFrame()}` : ""}`)
    await Bun.sleep(10)
  }
}

type Call = { path: string; body?: any }

const session = (id: string, parentID?: string) => ({
  id,
  slug: id,
  projectID: "proj_test",
  directory,
  title: id,
  version: "1",
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
})

const AGENTS = ["build", "plan", "dev-cycle"].map((name) => ({ name, mode: "primary", permission: [], options: {} }))
const model = (id: string, name: string) => ({
  id,
  providerID: "fake",
  name,
  api: { id, url: "", npm: "" },
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
})
const PROVIDER = {
  id: "fake",
  name: "Fake",
  source: "config",
  env: [],
  options: {},
  models: { "fake-1": model("fake-1", "Alpha One"), "fake-2": model("fake-2", "Beta Two") },
}

const asked = (id: string, sessionID: string) => ({
  id,
  sessionID,
  permission: "bash",
  patterns: ["git push"],
  metadata: {},
  always: [],
})

/** The session `ses_a` (with a subagent session `ses_child`) open in the prompt. `state` keeps kv.json between mounts. */
async function mount(input: { config?: Record<string, unknown>; state?: string } = {}) {
  const calls: Call[] = []
  const tmp = await tmpdir()
  const state = input.state ?? path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  if (!(await Bun.file(path.join(state, "kv.json")).exists())) await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const base = createFetch(undefined, events)
  const sessions = [session("ses_a"), session("ses_child", "ses_a")]
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const url = new URL(req.url)
    const method = req.method
    if (url.pathname === "/session" && method === "GET") return json(sessions)
    if (url.pathname === "/config" && method === "GET") return json(input.config ?? {})
    if (url.pathname === "/config/providers") return json({ providers: [PROVIDER], default: { fake: "fake-1" } })
    if (url.pathname === "/agent") return json(AGENTS)
    if (url.pathname === "/permission" && method === "GET") return json([])
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
    { RouteProvider, useRoute },
    { TuiConfigProvider, useTuiConfig },
    { SDKProvider },
    { PermissionProvider },
    { ProjectProvider },
    { SyncProvider, useSync },
    { DataProvider },
    { ThemeProvider },
    { LocalProvider, useLocal },
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
  const { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings, OPENCODE_BASE_MODE } = keymapModule

  let toast!: ReturnType<typeof useToast>
  let local!: ReturnType<typeof useLocal>
  function View() {
    const sync = useSync()
    const tuiConfig = useTuiConfig()
    const promptRef = usePromptRef()
    const route = useRoute()
    toast = useToast()
    local = useLocal()
    const [ready, setReady] = createSignal(false)
    onMount(() => {
      route.navigate({ type: "session", sessionID: "ses_a" })
      void wait(() => sync.status !== "loading" && !!sync.session.get("ses_a")).then(() => setReady(true))
    })
    // As app.tsx registers them: the palette command and its key from config.
    useBindings(() => ({
      commands: [
        { namespace: "palette", name: "mode.cycle", title: "Next mode", run: () => local.mode.move(1) },
        { namespace: "palette", name: "permission.mode", title: "Approval", run: () => local.approval.toggle() },
        { namespace: "palette", name: "model.list", title: "Models", run: () => {} },
      ],
    }))
    useBindings(() => ({
      mode: OPENCODE_BASE_MODE,
      bindings: tuiConfig.keybinds.gather("app", ["mode.cycle", "permission.mode", "model.list"]),
    }))
    return (
      <Show when={ready()}>
        <Prompt sessionID="ses_a" ref={(ref) => promptRef.set(ref)} placeholders={{ normal: ["Ask anything"] }} />
      </Show>
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
  const frame = () => app.captureCharFrame()
  lastFrame = frame
  await wait(() => frame().includes("Ask anything") && frame().includes("Build"))
  await Bun.sleep(100)
  const settle = () => Bun.sleep(80)
  return {
    frame,
    calls,
    state,
    local: () => local,
    toast: () => toast.currentToast?.message,
    /** The indicator line: `Workflow · Approval · model provider`. */
    indicator: () =>
      frame()
        .split("\n")
        .find((line) => /(Build|Plan|Dev-Cycle) · (Manual|Auto)/.test(line))
        ?.replace(/^[┃\s]+/, "")
        .trimEnd() ?? "",
    ask(id: string, sessionID: string) {
      events.emit({
        directory,
        project: "proj_test",
        payload: { id: `evt_${id}`, type: "permission.asked", properties: asked(id, sessionID) },
      } as any)
    },
    async tab() {
      app.mockInput.pressTab()
      await settle()
    },
    /** <leader>p: ctrl+x (the default leader), then p. */
    async approval() {
      app.mockInput.pressKey("x", { ctrl: true })
      await settle()
      app.mockInput.pressKey("p")
      await settle()
    },
    async send(text: string) {
      await app.mockInput.typeText(text)
      await settle()
      app.mockInput.pressEnter()
      await settle()
    },
    async cleanup(keep = false) {
      // kv.json is written asynchronously; let it land before a remount reads it.
      await Bun.sleep(150)
      app.renderer.destroy()
      if (!keep) void tmp[Symbol.asyncDispose]()
    },
  }
}

const replies = (ui: { calls: Call[] }) => ui.calls.filter((call) => /^\/permission\/[^/]+\/reply$/.test(call.path))

describe("approval and model per workflow", () => {
  test("Dev-Cycle to Auto with <leader>p; Build stays Manual; the footer shows the triple and the keys", async () => {
    const ui = await mount()
    try {
      await wait(() => ui.indicator().startsWith("Build · Manual · Alpha One"))
      // The keys, from config, in the hint line.
      expect(ui.frame()).toMatch(/ctrl\+x m model · ctrl\+x p approval/)
      await ui.tab()
      await ui.tab()
      await wait(() => ui.indicator().startsWith("Dev-Cycle · Manual"))
      await ui.approval()
      await wait(() => ui.indicator().startsWith("Dev-Cycle · Auto · Alpha One"))
      expect(ui.toast()).toBe("Dev-Cycle: Auto-approve on")
      await ui.tab()
      await wait(() => ui.indicator().startsWith("Build · Manual"))
      // Back to Dev-Cycle: still Auto in this session.
      await ui.tab()
      await ui.tab()
      await wait(() => ui.indicator().startsWith("Dev-Cycle · Auto"))
      await ui.approval()
      await wait(() => ui.indicator().startsWith("Dev-Cycle · Manual"))
      expect(ui.toast()).toBe("Dev-Cycle: Manual approval")
    } finally {
      await ui.cleanup()
    }
  })

  test("asks are answered under the workflow the session last ran, its subagents' too; Manual leaves them", async () => {
    const ui = await mount()
    try {
      await wait(() => ui.indicator().startsWith("Build"))
      await ui.tab()
      await ui.tab()
      await ui.approval()
      await wait(() => ui.indicator().startsWith("Dev-Cycle · Auto"))
      await ui.send("ship it")
      await wait(() =>
        ui.calls.some(
          (call) => call.path === "/session/ses_a/prompt_async" || /ses_a\/(prompt|message)/.test(call.path),
        ),
      )
      ui.ask("per_1", "ses_a")
      await wait(() => replies(ui).length === 1)
      expect(replies(ui)[0]).toMatchObject({ path: "/permission/per_1/reply", body: { reply: "once" } })
      // A Dev-Cycle phase subagent's ask follows the session's Auto.
      ui.ask("per_2", "ses_child")
      await wait(() => replies(ui).length === 2)
      expect(replies(ui)[1]!.path).toBe("/permission/per_2/reply")

      // The next prompt runs Build, which is Manual: its asks wait for the user.
      await ui.tab()
      await wait(() => ui.indicator().startsWith("Build · Manual"))
      await ui.send("and now this")
      await Bun.sleep(100)
      ui.ask("per_3", "ses_a")
      ui.ask("per_4", "ses_child")
      await Bun.sleep(300)
      expect(replies(ui)).toHaveLength(2)
    } finally {
      await ui.cleanup()
    }
  })

  test("each workflow keeps its own model and approval in the session, after a restart too", async () => {
    const first = await mount()
    const state = first.state
    try {
      await wait(() => first.indicator().startsWith("Build"))
      first.local().model.set({ providerID: "fake", modelID: "fake-2" })
      await wait(() => first.indicator().startsWith("Build · Manual · Beta Two"))
      await first.tab()
      await first.tab()
      await wait(() => first.indicator().startsWith("Dev-Cycle · Manual · Alpha One"))
      await first.approval()
      await wait(() => first.indicator().startsWith("Dev-Cycle · Auto · Alpha One"))
      await first.tab()
      await wait(() => first.indicator().startsWith("Build · Manual · Beta Two"))
    } finally {
      await first.cleanup(true)
    }
    const kv = await Bun.file(path.join(state, "kv.json")).json()
    expect(kv.workflow_state.ses_a.agents).toEqual({
      build: { model: { providerID: "fake", modelID: "fake-2" } },
      "dev-cycle": { approval: "auto" },
    })

    const second = await mount({ state })
    try {
      await wait(() => second.indicator().startsWith("Build · Manual · Beta Two"))
      await second.tab()
      await second.tab()
      await wait(() => second.indicator().startsWith("Dev-Cycle · Auto · Alpha One"))
    } finally {
      await second.cleanup()
    }
  })

  test("a workflow's default approval comes from agent.<name>.permission_mode", async () => {
    const ui = await mount({ config: { agent: { "dev-cycle": { permission_mode: "auto" } } } })
    try {
      await wait(() => ui.indicator().startsWith("Build · Manual"))
      await ui.tab()
      await ui.tab()
      await wait(() => ui.indicator().startsWith("Dev-Cycle · Auto"))
    } finally {
      await ui.cleanup()
    }
  })

  test("an organisation lock keeps Manual: <leader>p changes nothing and says why; asks still wait", async () => {
    const ui = await mount({
      config: {
        $locked: ["agent.dev-cycle.permission_mode"],
        agent: { "dev-cycle": { permission_mode: "manual" } },
      },
    })
    try {
      await wait(() => ui.indicator().startsWith("Build"))
      await ui.tab()
      await ui.tab()
      await wait(() => ui.indicator().startsWith("Dev-Cycle · Manual"))
      await ui.approval()
      await wait(() => ui.toast() === "Auto-approve is turned off by your organisation")
      expect(ui.indicator()).toStartWith("Dev-Cycle · Manual")
      await ui.send("go")
      ui.ask("per_1", "ses_a")
      await Bun.sleep(300)
      expect(replies(ui)).toEqual([])
    } finally {
      await ui.cleanup()
    }
  })
})

describe("resolveApproval", () => {
  test("lock, then the session's choice, then the workflow default, then --auto", () => {
    expect(resolveApproval({ agent: "build" })).toEqual({ mode: "normal" })
    expect(resolveApproval({ agent: "build", auto: true })).toEqual({ mode: "auto" })
    const config = { agent: { build: { permission_mode: "auto" } } }
    expect(resolveApproval({ agent: "build", config })).toEqual({ mode: "auto" })
    expect(resolveApproval({ agent: "build", config, stored: "normal" })).toEqual({ mode: "normal" })
    expect(resolveApproval({ agent: "plan", config, auto: false })).toEqual({ mode: "normal" })
    // A lock without a value is Manual; a lock wins over the session's choice and --auto.
    expect(resolveApproval({ agent: "build", config: { $locked: ["agent"] }, stored: "auto", auto: true })).toEqual({
      mode: "normal",
      lock: "agent",
    })
    expect(
      resolveApproval({ agent: "build", config: { ...config, $locked: ["agent.build"] }, stored: "normal" }),
    ).toEqual({ mode: "auto", lock: "agent.build" })
  })

  test("the lock entries that cover a workflow's approval", () => {
    expect(approvalLock(["agent.build.permission_mode"], "build")).toBe("agent.build.permission_mode")
    expect(approvalLock(["agent.build"], "build")).toBe("agent.build")
    expect(approvalLock(["agent"], "dev-cycle")).toBe("agent")
    expect(approvalLock(["agent.build.model", "agent.plan"], "build")).toBeUndefined()
    expect(approvalLock(undefined, "build")).toBeUndefined()
  })

  test("a subagent's session resolves to its top-level session", () => {
    const parents: Record<string, string> = { c: "b", b: "a" }
    expect(rootSession("c", (id) => parents[id])).toBe("a")
    expect(rootSession("a", (id) => parents[id])).toBe("a")
    // A cycle doesn't hang.
    expect(["x", "y"]).toContain(rootSession("x", (id) => (id === "x" ? "y" : "x")))
  })
})
