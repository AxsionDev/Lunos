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

// XCOD-285 §4: Settings › Models & agents › External sessions lists Claude Code's and Codex's own
// configuration; Enter opens it, and the tool is asked only then (not when /settings opens). 120x45.

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

test("External sessions: a row per tool opens its configuration, read only when opened", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const asked: string[] = []
  const events = createEventSource()
  const base = createFetch((url) => {
    if (url.pathname === "/api/event") return events.response()
    if (url.pathname === "/config/settings") return json({ rows: [], layers: [], locked: [] })
    if (url.pathname === "/experimental/external/tools") return json([])
    if (url.pathname === "/config/agents") return json([])
    if (url.pathname.startsWith("/experimental/external/config/")) {
      asked.push(url.pathname)
      return json({
        tool: "codex",
        label: "Codex CLI",
        version: "0.160.1",
        sections: [
          {
            id: "general",
            title: "Model and permissions",
            items: [{ id: "model", name: "Model", value: "gpt-5.5", source: { scope: "user", label: "user" } }],
          },
        ],
        notes: [],
      })
    }
    return undefined
  }, events)

  const [
    { ArgsProvider },
    { KVProvider },
    { ToastProvider },
    { RouteProvider },
    { TuiConfigProvider },
    { SDKProvider },
    { PermissionProvider },
    { ProjectProvider },
    { SyncProvider, useSync },
    { DataProvider },
    { ThemeProvider },
    { LocalProvider },
    { DialogProvider, useDialog },
    { ExitProvider },
    { ClipboardProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { DialogSettings },
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
    import("../../src/ui/dialog"),
    import("../../src/context/exit"),
    import("../../src/context/clipboard"),
    import("../../src/keymap"),
    import("../../src/component/dialog-settings"),
  ])

  function Start() {
    const sync = useSync()
    const dialog = useDialog()
    onMount(async () => {
      await wait(() => sync.status === "complete")
      dialog.replace(() => <DialogSettings tab="settings" area="Models & agents" sub="External sessions" />)
    })
    return <box />
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
                        <SDKProvider url="http://test" directory={directory} fetch={base.fetch} events={events.source}>
                          <PermissionProvider>
                            <ProjectProvider>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark">
                                    <LocalProvider>
                                      <DialogProvider>
                                        <Start />
                                      </DialogProvider>
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

  const app = await testRender(() => <Harness />, { width: 120, height: 45, kittyKeyboard: true })
  const frame = () => app.captureCharFrame()
  const see = async (text: string) => {
    try {
      await wait(() => frame().includes(text))
    } catch {
      throw new Error(`"${text}" never appeared. Last frame:\n${frame()}`)
    }
  }
  try {
    await see("Claude Code's own configuration")
    expect(frame()).toContain("Codex CLI's own configuration")
    expect(frame()).toContain("as the tool reports it")
    // Opening /settings doesn't start either tool.
    expect(asked).toEqual([])
    // Share with Claude Code, Share with Codex, Claude Code's, Codex's.
    for (let i = 0; i < 3; i++) {
      app.mockInput.pressArrow("down")
      await Bun.sleep(30)
    }
    await see("Lunos never writes the tool's files")
    app.mockInput.pressEnter()
    await see("Settings › External sessions › Codex CLI")
    await see("gpt-5.5")
    expect(asked).toEqual(["/experimental/external/config/codex"])
  } finally {
    app.renderer.destroy()
  }
})
