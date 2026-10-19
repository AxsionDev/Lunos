/** @jsxImportSource @opentui/solid */
// XCOD-233: the /settings window's keys. ← goes back one level (in a text field only from its
// start), Esc closes the whole window from any depth, and screens opened elsewhere keep Esc as it was.
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type { DialogContext } from "../../../src/ui/dialog"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(root: string, start: (dialog: DialogContext) => void) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])
  let dialog!: DialogContext

  function Start() {
    dialog = useDialog()
    onMount(() => start(dialog))
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Start />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 100, height: 40 })
  await wait(() => dialog !== undefined)
  return { app, dialog: () => dialog }
}

const editor = (app: Awaited<ReturnType<typeof mount>>["app"]) => app.renderer.currentFocusedEditor

test("← in a settings prompt moves the cursor, and at the start of the field goes back", async () => {
  await using tmp = await tmpdir()
  const { DialogPrompt } = await import("../../../src/ui/dialog-prompt")
  const back: string[] = []
  const results: (string | null)[] = []
  const ui = await mount(tmp.path, (dialog) => {
    void DialogPrompt.show(dialog, "Name", { value: "ab", nav: { back: () => back.push("back") } }).then((value) =>
      results.push(value),
    )
  })
  try {
    await wait(() => editor(ui.app) instanceof TextareaRenderable)
    const field = editor(ui.app) as TextareaRenderable
    await wait(() => field.cursorOffset === 2)
    ui.app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(field.cursorOffset).toBe(1)
    expect(back).toEqual([])
    ui.app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(field.cursorOffset).toBe(0)
    expect(back).toEqual([])
    ui.app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(back).toEqual(["back"])
    // Going back is the caller's job (it reopens the screen); nothing was confirmed.
    expect(results).toEqual([])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("Esc closes the whole settings window: the prompt doesn't resolve and a late reopen is dropped", async () => {
  await using tmp = await tmpdir()
  const { DialogPrompt } = await import("../../../src/ui/dialog-prompt")
  const results: (string | null)[] = []
  let generation = -1
  const ui = await mount(tmp.path, (dialog) => {
    generation = dialog.generation
    void DialogPrompt.show(dialog, "Name", { value: "typed", nav: { back: () => {} } }).then((value) =>
      results.push(value),
    )
  })
  try {
    await wait(() => editor(ui.app) instanceof TextareaRenderable)
    expect(ui.dialog().nav).toEqual({ back: true })
    ui.app.mockInput.pressEscape()
    await Bun.sleep(20)
    expect(ui.dialog().stack.length).toBe(0)
    expect(results).toEqual([])
    // A save that finishes after Esc tries to reopen the screen it came from: it's dropped.
    ui.dialog().replace(() => <text>late</text>, undefined, { back: () => {}, generation })
    expect(ui.dialog().stack.length).toBe(0)
  } finally {
    ui.app.renderer.destroy()
  }
})

test("← on a settings list goes back; on the window's top level it does nothing", async () => {
  await using tmp = await tmpdir()
  const { DialogSelect } = await import("../../../src/ui/dialog-select")
  const back: string[] = []
  const ui = await mount(tmp.path, (dialog) => {
    dialog.replace(() => <DialogSelect title="Top" options={[{ title: "a", value: "a" }]} />, undefined, { nav: true })
  })
  try {
    await wait(() => editor(ui.app) instanceof InputRenderable)
    expect(ui.dialog().nav).toEqual({ back: false })
    ui.app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(ui.dialog().stack.length).toBe(1)
    ui.dialog().replace(() => <DialogSelect title="Picker" options={[{ title: "b", value: "b" }]} />, undefined, {
      back: () => back.push("picker"),
    })
    await Bun.sleep(20)
    expect(ui.dialog().nav).toEqual({ back: true })
    ui.app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(back).toEqual(["picker"])
    // A screen the picker opens itself (a plain replace) is still in the window, with the same way back.
    ui.dialog().replace(() => <DialogSelect title="Inner" options={[{ title: "c", value: "c" }]} />)
    await Bun.sleep(20)
    expect(ui.dialog().nav).toEqual({ back: true })
  } finally {
    ui.app.renderer.destroy()
  }
})

test("outside /settings, Esc still pops only the dialog and a prompt resolves null", async () => {
  await using tmp = await tmpdir()
  const { DialogPrompt } = await import("../../../src/ui/dialog-prompt")
  const results: (string | null)[] = []
  const ui = await mount(tmp.path, (dialog) => {
    void DialogPrompt.show(dialog, "Rename", { value: "x" }).then((value) => results.push(value))
  })
  try {
    await wait(() => editor(ui.app) instanceof TextareaRenderable)
    expect(ui.dialog().nav).toBeUndefined()
    const field = editor(ui.app) as TextareaRenderable
    ui.app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(field.cursorOffset).toBe(0)
    ui.app.mockInput.pressArrow("left")
    await Bun.sleep(20)
    expect(ui.dialog().stack.length).toBe(1)
    ui.app.mockInput.pressEscape()
    await wait(() => results.length === 1)
    expect(results).toEqual([null])
  } finally {
    ui.app.renderer.destroy()
  }
})
