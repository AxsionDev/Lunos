/** @jsxImportSource @opentui/solid */
// XCOD-285: a Claude Code / Codex session works like the tool. Driven by keys in a headless 120x45
// terminal against a fake server: the approval prompt offers the tool's own choices (as the server
// builds them from the tool's request) and each sends the Lunos reply that maps to the tool's decision;
// Shift+Tab cycles Claude Code's permission mode through what the install's --help lists, and the
// status line shows it. An older Claude Code (fewer modes, no suggestions) shows less.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { ConfigExternal } from "@opencode-ai/core/config/external"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { externalChoices } from "../../src/util/external-permission"
import { externalBadge } from "../../src/util/external"
import { externalModeLabel } from "../../src/component/external-profile"

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

// What --help lists for --permission-mode: 2.1.304 (recorded), and an older set without plan.
const MODES = {
  current: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
  older: ["acceptEdits", "bypassPermissions", "default"],
}

// The choices the server sends with an approval (ExternalNative.choices), for the recorded requests.
const CHOICES = {
  claude: [
    { id: "yes", label: "Yes", reply: "once" },
    { id: "always", label: "Yes, and don't ask again for edits in this session (accept edits mode)", reply: "always" },
    { id: "no", label: "No, and tell Claude what to do differently", reply: "reject", feedback: true },
  ],
  claudeOlder: [
    { id: "yes", label: "Yes", reply: "once" },
    { id: "no", label: "No, and tell Claude what to do differently", reply: "reject", feedback: true },
  ],
  codex: [
    { id: "accept", label: "Yes", reply: "once" },
    { id: "acceptForSession", label: "Yes, and don't ask again for these files", reply: "always" },
    {
      id: "decline",
      label: "No, carry on without it",
      reply: "reject",
      message: "Declined in Lunos; carry on without it.",
    },
    { id: "cancel", label: "No, and stop", reply: "reject" },
  ],
}

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

async function mount(input: { tool?: Tool; modes?: string[]; choices?: unknown[]; marker?: Record<string, unknown> }) {
  const marker = input.tool ? { tool: input.tool, session: "thread-1", ...input.marker } : undefined
  const session = {
    id: "ses_ext",
    slug: "ses_ext",
    projectID: "proj_test",
    directory,
    title: "fix-auth",
    version: "1",
    time: { created: 1, updated: 1 },
    ...(marker ? { metadata: { external: marker } } : {}),
  }
  const calls: Call[] = []
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const events = createEventSource()
  const base = createFetch(undefined, events)
  const permission = input.choices
    ? {
        id: "per_1",
        sessionID: "ses_ext",
        permission: "external",
        patterns: [`${input.tool}:Write /work/hello.txt`],
        metadata: { tool: input.tool, label: "Claude Code", action: "Write", choices: input.choices },
        always: [`${input.tool}:Write *`],
      }
    : undefined
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const url = new URL(req.url)
    const method = req.method
    if (url.pathname === "/session" && method === "GET") return json([session])
    if (url.pathname === "/session/status") return json({})
    if (url.pathname === "/config/providers") return json({ providers: [PROVIDER], default: { fake: "fake-1" } })
    if (url.pathname === "/agent") return json([AGENT])
    if (url.pathname === "/permission" && method === "GET") return json([])
    if (url.pathname === "/question" && method === "GET") return json([])
    if (url.pathname === "/experimental/external/tools")
      return json([
        { tool: "claude", label: "Claude Code", installed: true, loggedIn: true, permissionModes: input.modes },
        { tool: "codex", label: "Codex CLI", installed: true, loggedIn: true },
      ])
    if (url.pathname === "/session/ses_ext" && method === "GET") return json(session)
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
    { ToastProvider },
    { RouteProvider, useRoute },
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
    { PromptRefProvider, usePromptRef },
    { EditorContextProvider },
    { LocationProvider },
    { ExitProvider },
    { ClipboardProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { Prompt },
    { PermissionPrompt },
    { useExternalKeyProfile },
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
    import("../../src/routes/session/permission"),
    import("../../src/component/external-profile"),
  ])

  function View() {
    const sync = useSync()
    const route = useRoute()
    const promptRef = usePromptRef()
    const [ready, setReady] = createSignal(false)
    // As the session route mounts it.
    useExternalKeyProfile(() => (ready() ? "ses_ext" : undefined))
    onMount(() => {
      route.navigate({ type: "session", sessionID: "ses_ext" })
      void wait(() => sync.status !== "loading" && !!sync.session.get("ses_ext")).then(() => setReady(true))
    })
    return (
      <box>
        <Show when={ready() && permission}>
          <PermissionPrompt request={permission as any} directory={directory} />
        </Show>
        <Show when={ready()}>
          <Prompt sessionID="ses_ext" ref={(ref) => promptRef.set(ref)} placeholders={{ normal: ["Ask anything"] }} />
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
  await wait(() => frame().includes("Ask anything"))
  await Bun.sleep(100)
  const settle = () => Bun.sleep(80)
  return {
    frame,
    calls,
    /** The server saved a new marker (as session.updated after the mode POST). */
    update(next: Record<string, unknown>) {
      Object.assign(session, { metadata: { external: { ...marker, ...next } } })
      events.emit({
        directory,
        project: "proj_test",
        payload: {
          id: `evt_${Date.now()}`,
          type: "session.updated",
          properties: { sessionID: "ses_ext", info: session },
        },
      } as any)
    },
    async key(name: string, modifiers?: { shift?: boolean; ctrl?: boolean }) {
      app.mockInput.pressKey(name, modifiers)
      await settle()
    },
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
    async arrow(direction: "up" | "down") {
      app.mockInput.pressArrow(direction)
      await settle()
    },
    async cleanup() {
      await Bun.sleep(50)
      app.renderer.destroy()
      void tmp[Symbol.asyncDispose]()
    },
  }
}

const replies = (ui: { calls: Call[] }) =>
  ui.calls.filter((call) => /\/permission\/per_1\/reply$/.test(call.path)).map((call) => call.body)
const modes = (ui: { calls: Call[] }) =>
  ui.calls.filter((call) => call.path === "/experimental/external/ses_ext/mode").map((call) => call.body.mode)

test("the status line names the permission mode the tool runs in, not its default", () => {
  expect(externalBadge("claude", "sonnet", externalModeLabel({ permissionMode: "acceptEdits", mode: "default" }))).toBe(
    "Lunos · Claude Code · sonnet · acceptEdits",
  )
  expect(externalModeLabel({ mode: "manual" })).toBeUndefined()
  expect(externalModeLabel({ mode: "plan" })).toBe("plan")
  // Choices that can't both allow and refuse aren't a prompt: Lunos's own is shown instead.
  expect(externalChoices({ choices: [{ id: "yes", label: "Yes", reply: "once" }] })).toBeUndefined()
  expect(externalChoices({})).toBeUndefined()
  expect(ConfigExternal.cycle(MODES.current)).toEqual(["manual", "acceptEdits", "plan"])
})

describe("Claude Code approval: its three choices, each mapped", () => {
  test("they render in its wording, one per line", async () => {
    const ui = await mount({ tool: "claude", choices: CHOICES.claude })
    try {
      await wait(() => ui.frame().includes("No, and tell Claude what to do differently"))
      const frame = ui.frame()
      expect(frame).toContain("Yes, and don't ask again for edits in this session (accept edits mode)")
      expect(frame).not.toContain("Allow always")
      const rows = frame.split("\n")
      const row = (text: string) => rows.findIndex((line) => line.includes(text))
      expect(row("Yes, and don't ask")).toBe(row("No, and tell Claude") - 1)
    } finally {
      await ui.cleanup()
    }
  })

  test("Yes → once; don't ask again → always", async () => {
    for (const [moves, reply] of [
      [0, "once"],
      [1, "always"],
    ] as const) {
      const ui = await mount({ tool: "claude", choices: CHOICES.claude })
      try {
        await wait(() => ui.frame().includes("No, and tell Claude"))
        for (let i = 0; i < moves; i++) await ui.arrow("down")
        await ui.enter()
        await wait(() => replies(ui).length === 1)
        expect(replies(ui)).toEqual([{ reply }])
      } finally {
        await ui.cleanup()
      }
    }
  })

  test("No asks what to do differently: with text the tool carries on with it; Esc refuses and stops", async () => {
    const ui = await mount({ tool: "claude", choices: CHOICES.claude })
    try {
      await wait(() => ui.frame().includes("No, and tell Claude"))
      await ui.arrow("down")
      await ui.arrow("down")
      await ui.enter()
      await wait(() => ui.frame().includes("Tell Claude what to do differently"))
      await ui.type("use greeting.txt")
      await ui.enter()
      await wait(() => replies(ui).length === 1)
      expect(replies(ui)).toEqual([{ reply: "reject", message: "use greeting.txt" }])
    } finally {
      await ui.cleanup()
    }
    const esc = await mount({ tool: "claude", choices: CHOICES.claude })
    try {
      await wait(() => esc.frame().includes("No, and tell Claude"))
      await esc.escape()
      await wait(() => replies(esc).length === 1)
      // No message: the server answers Claude Code with deny + interrupt.
      expect(replies(esc)).toEqual([{ reply: "reject" }])
    } finally {
      await esc.cleanup()
    }
  })

  test("an older Claude Code that offers no suggestion has no don't-ask-again choice", async () => {
    const ui = await mount({ tool: "claude", choices: CHOICES.claudeOlder })
    try {
      await wait(() => ui.frame().includes("No, and tell Claude"))
      expect(ui.frame()).not.toContain("don't ask again")
    } finally {
      await ui.cleanup()
    }
  })
})

test("Codex approval: its decisions; decline carries on, cancel stops", async () => {
  for (const [moves, expected] of [
    [1, { reply: "always" }],
    [2, { reply: "reject", message: "Declined in Lunos; carry on without it." }],
    [3, { reply: "reject" }],
  ] as const) {
    const ui = await mount({ tool: "codex", choices: CHOICES.codex })
    try {
      await wait(() => ui.frame().includes("No, and stop"))
      expect(ui.frame()).toContain("Yes, and don't ask again for these files")
      for (let i = 0; i < moves; i++) await ui.arrow("down")
      await ui.enter()
      await wait(() => replies(ui).length === 1)
      expect(replies(ui)).toEqual([expected])
    } finally {
      await ui.cleanup()
    }
  }
})

describe("Shift+Tab cycles Claude Code's permission mode, as in the tool", () => {
  test("through what 2.1.304 lists: manual → acceptEdits → plan → manual; the status line follows", async () => {
    const ui = await mount({ tool: "claude", modes: MODES.current, marker: { mode: "manual" } })
    try {
      expect(ui.frame()).toContain("Lunos · Claude Code")
      expect(ui.frame()).not.toContain("acceptEdits")
      await ui.key("TAB", { shift: true })
      await wait(() => modes(ui).length === 1)
      expect(modes(ui)).toEqual(["acceptEdits"])
      ui.update({ permissionMode: "acceptEdits" })
      await wait(() => ui.frame().includes("Lunos · Claude Code · acceptEdits"))
      await ui.key("TAB", { shift: true })
      await wait(() => modes(ui).length === 2)
      ui.update({ permissionMode: "plan" })
      await wait(() => ui.frame().includes("Lunos · Claude Code · plan"))
      await ui.key("TAB", { shift: true })
      await wait(() => modes(ui).length === 3)
      // Never into a mode that skips or auto-decides approvals.
      expect(modes(ui)).toEqual(["acceptEdits", "plan", "manual"])
    } finally {
      await ui.cleanup()
    }
  })

  test("an older Claude Code without plan cycles only what it lists", async () => {
    const ui = await mount({ tool: "claude", modes: MODES.older, marker: { mode: "default" } })
    try {
      await ui.key("TAB", { shift: true })
      await wait(() => modes(ui).length === 1)
      ui.update({ permissionMode: "acceptEdits" })
      await wait(() => ui.frame().includes("acceptEdits"))
      await ui.key("TAB", { shift: true })
      await wait(() => modes(ui).length === 2)
      expect(modes(ui)).toEqual(["acceptEdits", "default"])
    } finally {
      await ui.cleanup()
    }
  })

  test("in a Codex session Shift+Tab doesn't touch a permission mode (it has none to cycle)", async () => {
    const ui = await mount({ tool: "codex", modes: MODES.current })
    try {
      await ui.key("TAB", { shift: true })
      await Bun.sleep(200)
      expect(modes(ui)).toEqual([])
    } finally {
      await ui.cleanup()
    }
  })
})
