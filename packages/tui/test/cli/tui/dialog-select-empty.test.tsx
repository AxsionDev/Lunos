/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { TuiKeybind } from "../../../src/config/keybind"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type { DialogSelectProps } from "../../../src/ui/dialog-select"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountSelect(input: {
  root: string
  keybinds: Partial<TuiKeybind.Keybinds>
  actions: DialogSelectProps<string>["actions"]
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogSelect },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-select"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: input.keybinds,
      leader_timeout: 1000,
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <DialogSelect title="Discover" options={[]} actions={input.actions} />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

// Marketplace Discover (packages/tui/src/feature-plugins/system/plugins.tsx) switches content tabs
// with a DialogSelect action. A tab can be legitimately empty -- the community marketplace ships no
// skills -- and an action that silently required a selected row left the user stranded there,
// unable to reach the MCP tab.
test("an action that doesn't need a row still fires on an empty list", async () => {
  await using tmp = await tmpdir()
  const fired: string[] = []
  const select = await mountSelect({
    root: tmp.path,
    keybinds: { "dialog.plugins.discover.next_kind": "ctrl+o" },
    actions: [
      {
        title: "next tab",
        command: "dialog.plugins.discover.next_kind",
        withoutSelection: true,
        onTrigger: () => fired.push("next"),
      },
    ],
  })

  try {
    await Bun.sleep(100)
    select.app.mockInput.pressKey("o", { ctrl: true })
    await wait(() => fired.length > 0)
    expect(fired).toEqual(["next"])
  } finally {
    await select.cleanup()
  }
})

// XCOD-265: /sessions' "stop all" and "clear list" ship with no key. `menu` keeps such an action in
// the footer and the Tab menu; an unbound action without it stays out, as before.
test("an unbound menu action is in the footer and runs from the Tab menu", async () => {
  await using tmp = await tmpdir()
  const fired: string[] = []
  const select = await mountSelect({
    root: tmp.path,
    keybinds: { "dialog.sessions.stop_all": "none", "dialog.sessions.clear": "none" },
    actions: [
      {
        title: "stop all",
        command: "dialog.sessions.stop_all",
        menu: true,
        withoutSelection: true,
        onTrigger: () => fired.push("stop all"),
      },
      {
        title: "clear list",
        command: "dialog.sessions.clear",
        withoutSelection: true,
        onTrigger: () => fired.push("clear"),
      },
    ],
  })

  try {
    await Bun.sleep(100)
    const frame = select.app.captureCharFrame()
    expect(frame).toContain("stop all")
    expect(frame).not.toContain("clear list")
    select.app.mockInput.pressTab()
    await Bun.sleep(50)
    select.app.mockInput.pressEnter()
    await wait(() => fired.length > 0)
    expect(fired).toEqual(["stop all"])
  } finally {
    await select.cleanup()
  }
})

// XCOD-265: /sessions refreshes under the footer. When an action before the focused one is disabled
// (or appears), the highlight stays on the same action instead of sliding to its neighbour.
test("the focused footer action stays put when the actions before it change", async () => {
  const { createSignal } = await import("solid-js")
  await using tmp = await tmpdir()
  const fired: string[] = []
  const [stopEnabled, setStopEnabled] = createSignal(true)
  const select = await mountSelect({
    root: tmp.path,
    keybinds: {},
    actions: [
      {
        title: "stop",
        command: "dialog.sessions.stop",
        menu: true,
        withoutSelection: true,
        disabled: () => !stopEnabled(),
        onTrigger: () => fired.push("stop"),
      },
      {
        title: "stop all",
        command: "dialog.sessions.stop_all",
        menu: true,
        withoutSelection: true,
        onTrigger: () => fired.push("stop all"),
      },
      {
        title: "clear list",
        command: "dialog.sessions.clear",
        menu: true,
        withoutSelection: true,
        onTrigger: () => fired.push("clear"),
      },
    ],
  })

  try {
    await Bun.sleep(100)
    select.app.mockInput.pressTab()
    select.app.mockInput.pressTab()
    await Bun.sleep(50)
    setStopEnabled(false)
    await Bun.sleep(50)
    select.app.mockInput.pressEnter()
    await wait(() => fired.length > 0)
    expect(fired).toEqual(["stop all"])
  } finally {
    await select.cleanup()
  }
})
