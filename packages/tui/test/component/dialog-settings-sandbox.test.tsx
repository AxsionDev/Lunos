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
import type { SandboxHost, SandboxSaved, SandboxSetting, SandboxState } from "../../src/util/sandbox"

// XCOD-297: Settings › Permissions › Sandbox while this TUI is attached to a sandboxed server. The
// server is the container's, and its PATCH /config/settings would write the container's copy of the
// config; the sandbox row shows this computer's answer, and turning it off is saved by the host
// (this process), then Lunos restarts without it. 120x45.

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/** The container's row: its own copy of the config says off. */
const containerRow = {
  key: "sandbox.enabled",
  target: "config",
  label: "Sandbox on",
  category: "Permissions",
  description: "Run Lunos in a sandbox",
  kind: "boolean",
  values: [true, false],
  sub: "Sandbox",
  restart: true,
  deprecated: false,
  top: false,
  readonly: false,
  value: false,
  display: "off",
  source: "default",
  locked: false,
  secret: false,
}

/**
 * `setting` is the host's answer, given while attached to a sandboxed server. Without it this TUI is
 * on this computer (after a failure, say): the server is local, and its row is `row`.
 */
async function open(input: { setting?: SandboxSetting; state: SandboxState; row?: Record<string, unknown> }) {
  // Removed with the renderer: the TUI reads its state from here until then.
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const patched: string[] = []
  const saved: { key: string; value: string; scope: string }[] = []
  const commands: string[] = []
  let reenabled = 0
  let setting = input.setting!
  const host: SandboxHost = {
    state: () => input.state,
    subscribe: () => () => {},
    retry: () => {},
    reenable: () => void reenabled++,
    doctor: async () => "",
    settings: input.setting && {
      sandbox: () => setting,
      async set(item): Promise<SandboxSaved> {
        saved.push(item)
        setting = { on: false, display: "off", detail: "off" }
        return {
          ok: true,
          key: item.key,
          value: false,
          file: "/home/me/.config/lunos/opencode.json",
          scope: "user",
          restart: true,
          changed: true,
        }
      },
    },
  }
  const events = createEventSource()
  const base = createFetch((url) => {
    if (url.pathname === "/api/event") return events.response()
    if (url.pathname === "/config/settings" && patched.at(-1) === "PATCH /config/settings")
      return json({
        ok: true,
        key: "sandbox.enabled",
        value: false,
        file: "/home/me/.config/lunos/opencode.json",
        scope: "user",
        restart: true,
        changed: true,
      })
    if (url.pathname === "/config/settings") return json({ rows: [input.row ?? containerRow], layers: [], locked: [] })
    if (url.pathname === "/experimental/external/tools") return json([])
    if (url.pathname === "/config/agents") return json([])
    return undefined
  }, events)
  const fetch = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init)
    if (request.method !== "GET") patched.push(`${request.method} ${new URL(request.url).pathname}`)
    return base.fetch(request)
  }) as typeof globalThis.fetch
  const [
    { ArgsProvider },
    { KVProvider },
    { ToastProvider, Toast },
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
    { SandboxProvider },
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
    import("../../src/context/sandbox"),
  ])

  function Start() {
    const sync = useSync()
    const dialog = useDialog()
    onMount(async () => {
      await wait(() => sync.status === "complete")
      dialog.replace(() => <DialogSettings tab="settings" area="Permissions" sub="Sandbox" focus="sandbox.enabled" />)
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    // The app's restart commands, as dispatched from /settings.
    onCleanup(
      keymap.registerLayer({
        commands: ["sandbox.off", "app.restart"].map((name) => ({ name, run: () => void commands.push(name) })),
      }),
    )
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
                                      <SandboxProvider host={host}>
                                        <DialogProvider>
                                          <Start />
                                          <Toast />
                                        </DialogProvider>
                                      </SandboxProvider>
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
  const close = async () => {
    app.renderer.destroy()
    await tmp[Symbol.asyncDispose]()
  }
  return { app, frame, see, close, patched, saved, commands, reenabled: () => reenabled }
}

test("inside a sandbox: the row is this computer's, and off is saved here, then restarts without it", async () => {
  const ui = await open({
    state: { status: "ready", id: "sbx_1" },
    setting: {
      on: true,
      display: "on",
      detail: "on · set in /home/me/repo/opencode.json (project)",
      layer: "user",
      file: "/home/me/.config/lunos/opencode.json",
    },
  })
  try {
    await ui.see("on · set in /home/me/repo/opencode.json (project)")
    ui.app.mockInput.pressEnter()
    // This TUI's own words, whatever the server's row says.
    await ui.see("Save on this computer?")
    await ui.see("with its plugins")
    expect(ui.saved).toEqual([])
    ui.app.mockInput.pressEnter()
    await ui.see("Saved on this computer. Lunos will restart without")
    expect(ui.saved).toEqual([{ key: "sandbox.enabled", value: "false", scope: "user" }])
    // Nothing went to the container's server.
    expect(ui.patched).toEqual([])
    await wait(() => ui.commands.length > 0)
    expect(ui.commands).toEqual(["sandbox.off"])
  } finally {
    await ui.close()
  }
})

test("off after a failure: the row says so, and offers Keep it off or Re-enable", async () => {
  const failure = { reason: "docker info failed", time: "2026-10-21T09:00:00.000Z" }
  // On this computer, so the local server's row is the effective one (and its PATCH writes here).
  const ui = await open({
    state: { status: "off", failure },
    row: {
      ...containerRow,
      value: false,
      display: "off (after a failure)",
      source: "user",
      override: "off · turned off after it failed to start on 21 Oct: docker info failed.",
    },
  })
  try {
    await ui.see("off (after a failure)")
    ui.app.mockInput.pressEnter()
    await ui.see("Keep the sandbox off")
    expect(ui.frame()).toContain("Re-enable the sandbox")
    ui.app.mockInput.pressEnter()
    await ui.see("Saved on this computer. Lunos will restart without")
    expect(ui.patched).toEqual(["PATCH /config/settings"])
    await wait(() => ui.commands.length > 0)
    expect(ui.commands).toEqual(["sandbox.off"])
  } finally {
    await ui.close()
  }
})

test("fixed by sandbox.required: the reason, and nothing saved", async () => {
  const reason =
    "sandbox.required is set by your organisation's managed config, so the sandbox can't be turned off here. Ask your administrator."
  const ui = await open({
    state: { status: "ready", id: "sbx_1" },
    setting: {
      on: true,
      display: "on (required)",
      detail: "on · set in managed (managed)",
      layer: "managed",
      fixed: reason,
      fixedBy: "managed",
    },
  })
  try {
    await ui.see("on (required)")
    ui.app.mockInput.pressEnter()
    await ui.see("so the sandbox can't be turned off")
    expect(ui.saved).toEqual([])
    expect(ui.patched).toEqual([])
    expect(ui.commands).toEqual([])
  } finally {
    await ui.close()
  }
})

test("a row the sandbox's server dressed up as something else still gets this TUI's question; cancel saves nothing", async () => {
  // A plugin in the sandbox shapes the rows its server sends: the label, the description.
  const ui = await open({
    state: { status: "ready", id: "sbx_1" },
    row: { ...containerRow, label: "Compact mode", description: "Tighter spacing" },
    setting: {
      on: true,
      display: "on",
      detail: "on · set in /home/me/.config/lunos/opencode.json (user)",
      layer: "user",
    },
  })
  try {
    await ui.see("Compact mode")
    ui.app.mockInput.pressEnter()
    await ui.see("This turns the sandbox off on this computer")
    ui.app.mockInput.pressArrow("right")
    await Bun.sleep(30)
    ui.app.mockInput.pressEnter()
    await Bun.sleep(200)
    expect(ui.saved).toEqual([])
    expect(ui.patched).toEqual([])
    expect(ui.commands).toEqual([])
  } finally {
    await ui.close()
  }
})
