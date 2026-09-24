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
