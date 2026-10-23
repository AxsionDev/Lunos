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

// XCOD-306: Settings scoped to a project. Only keys a project can set, each with its value and
// where it comes from; the file a Shared change goes to is shown before saving; a key a repository
// can't set is yours only, with why, and is saved to your own config; the project's theme for
// "just me" is kept in kv.json and never written to the repository. 120x45, server mocked.

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const row = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  target: key.startsWith("tui.") ? "tui" : "config",
  label: key,
  category: "Models & agents",
  description: `${key} description`,
  kind: "string",
  restart: false,
  deprecated: false,
  top: true,
  readonly: false,
  display: "not set",
  source: "default",
  locked: false,
  secret: false,
  ...extra,
})

const ROWS = [
  row("model", {
    display: "anthropic/claude",
    value: "anthropic/claude",
    source: "project",
    from: "/work/web/lunos.json",
  }),
  row("autoupdate", { display: "true", value: true }),
  row("share", { display: "manual", value: "manual" }),
  row("sandbox.allow", { kind: "list", category: "Permissions", display: "not set" }),
  row("verify.test", { display: "npm test", value: "npm test", source: "project" }),
  row("residency.allow", { display: "eu", source: "managed", locked: true }),
  row("tui.theme", { category: "Appearance", display: "catppuccin", value: "catppuccin" }),
]
const FILES = {
  user: { config: "/home/me/.config/lunos/lunos.json", tui: "/home/me/.config/lunos/tui.json" },
  project: { config: "/work/web/lunos.json", tui: "/work/web/tui.json" },
}

async function open() {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const writes: { scope: string; key: string; value: unknown; directory?: string | null }[] = []
  const events = createEventSource()
  const base = createFetch((url) => {
    if (url.pathname === "/api/event") return events.response()
    if (url.pathname === "/config/settings")
      return json({ rows: ROWS, layers: [], locked: ["residency.allow"], files: FILES })
    if (url.pathname === "/experimental/external/tools") return json([])
    if (url.pathname === "/config/agents") return json([])
    if (url.pathname === "/experimental/project-group") return json({ groups: [], current: {} })
    return undefined
  }, events)
  const fetch = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init)
    const url = new URL(request.url)
    if (request.method === "PATCH" && url.pathname === "/config/settings") {
      const body = await request.json()
      writes.push({ ...body, directory: url.searchParams.get("directory") })
      return json({
        ok: true,
        key: body.key,
        value: body.value,
        file: body.scope === "project" ? FILES.project.config : FILES.user.config,
        scope: body.scope,
        restart: false,
        changed: true,
      })
    }
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
      dialog.replace(() => (
        <DialogSettings
          tab="settings"
          project={{ ref: { key: "pgrp_web", name: "Axsion web", kind: "named" }, directory: "/work/web" }}
        />
      ))
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
                        <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                          <PermissionProvider>
                            <ProjectProvider>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark">
                                    <LocalProvider>
                                      <DialogProvider>
                                        <Start />
                                        <Toast />
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
  const settle = () => Bun.sleep(80)
  return {
    app,
    frame,
    see,
    writes,
    kv: async () => {
      await Bun.sleep(50)
      return Bun.file(path.join(state, "kv.json")).json()
    },
    async key(name: string, modifiers?: { ctrl?: boolean }) {
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
    async down(times = 1) {
      for (let i = 0; i < times; i++) {
        app.mockInput.pressArrow("down")
        await settle()
      }
    },
    async close() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("only keys a project can set, with value and source; the Shared file is shown before saving", async () => {
  const ui = await open()
  try {
    await ui.see("Settings › Project: Axsion web")
    await ui.see("Shared, saved to /work/web/lunos.json")
    const screen = ui.frame()
    for (const text of [
      "Theme for this project",
      "Name and folders…",
      "Budget…",
      "model",
      "verify.test",
      "sandbox.allow",
    ])
      expect(screen).toContain(text)
    // Not project settings: your own preferences, and the theme row (it has its own).
    expect(screen).not.toContain("autoupdate")
    expect(screen).not.toContain("share ")
    expect(screen).not.toContain("tui.theme")
    // Value and where it comes from.
    expect(screen).toMatch(/model\s+anthropic\/claude\s+project/)
  } finally {
    await ui.close()
  }
}, 20_000)

test("a Shared change is written to the project's config, for its folder", async () => {
  const ui = await open()
  try {
    await ui.see("verify.test")
    await ui.type("verify")
    await ui.see("verify.test description")
    await ui.see("Shared: saved to /work/web/lunos.json, so teammates get it")
    await ui.enter()
    // The inline editor: replace the value and save.
    await ui.key("u", { ctrl: true })
    await ui.type("bun test")
    await ui.enter()
    await wait(() => ui.writes.length === 1)
    expect(ui.writes[0]).toMatchObject({
      key: "verify.test",
      value: "bun test",
      scope: "project",
      directory: "/work/web",
    })
  } finally {
    await ui.close()
  }
}, 20_000)

test("a key a repository can't set is yours only, with why, and saved to your own config", async () => {
  const ui = await open()
  try {
    await ui.see("sandbox.allow")
    await ui.type("sandbox.allow")
    await ui.see("Yours only, saved to your own config")
    expect(ui.frame().replace(/\s+/g, " ")).toContain("extra hosts for the sandbox's network are yours to allow")
  } finally {
    await ui.close()
  }
}, 20_000)

test("Theme for this project, just me: kept in kv.json, never written to the repository", async () => {
  const ui = await open()
  try {
    await ui.see("Theme for this project")
    await ui.enter()
    await ui.see("Theme for Axsion web")
    await ui.see("Just me…")
    await ui.enter()
    await ui.see("Axsion web: theme for just you")
    await ui.type("dracula")
    await ui.enter()
    await ui.see("dracula  just me")
    expect((await ui.kv())["project_theme:pgrp_web"]).toBe("dracula")
    expect(ui.writes).toEqual([])
  } finally {
    await ui.close()
  }
}, 20_000)

test("Theme for this project, shared: written to the project's tui.json", async () => {
  const ui = await open()
  try {
    await ui.see("Theme for this project")
    await ui.enter()
    await ui.see("written to /work/web/tui.json for the team")
    await ui.down()
    await ui.enter()
    await ui.see("Axsion web: shared theme")
    await ui.type("nord")
    await ui.enter()
    await wait(() => ui.writes.length === 1)
    expect(ui.writes[0]).toMatchObject({ key: "tui.theme", value: "nord", scope: "project", directory: "/work/web" })
    expect((await ui.kv())["project_theme:pgrp_web"]).toBeUndefined()
  } finally {
    await ui.close()
  }
}, 20_000)
