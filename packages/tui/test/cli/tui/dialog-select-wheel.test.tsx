/** @jsxImportSource @opentui/solid */
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

// XCOD-206: /settings (and the plugins dialog) feed onMove back into `current`. Wheel-scrolling
// put a new row under the pointer, hover moved the selection, the echoed `current` re-centred the
// list, a new row landed under the pointer, and so on: the list never settled.

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function findScrollBox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node
  for (const child of node.getChildren() as Renderable[]) {
    const found = findScrollBox(child)
    if (found) return found
  }
}

async function mountList(root: string, moves: string[]) {
  const state = path.join(root, "state")
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

  const options = Array.from({ length: 80 }, (_, index) => ({ title: `Setting ${index}`, value: `key.${index}` }))

  function List() {
    // The same wiring as DialogSettings: the highlighted row is fed back as `current`.
    const [highlighted, setHighlighted] = createSignal<string>()
    return (
      <DialogSelect<string>
        title="Settings"
        skipFilter
        preserveSelection
        current={highlighted()}
        options={options}
        onMove={(option) => {
          moves.push(option.value)
          setHighlighted(option.value)
        }}
      />
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({})
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <List />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  return testRender(() => <Harness />, { width: 100, height: 40 })
}

async function frames(app: Awaited<ReturnType<typeof mountList>>, count: number) {
  for (let i = 0; i < count; i++) {
    await app.renderOnce()
    await Bun.sleep(5)
  }
}

test("wheel scrolling a list that echoes onMove into current settles", async () => {
  await using tmp = await tmpdir()
  const moves: string[] = []
  const app = await mountList(tmp.path, moves)

  try {
    await frames(app, 5)
    await wait(() => findScrollBox(app.renderer.root) !== undefined)
    const scroll = findScrollBox(app.renderer.root)!
    const x = scroll.x + 6
    // Off the centre row: re-centring then puts a different row under the pointer.
    const y = scroll.y + 2

    await app.mockMouse.moveTo(x, y)
    await frames(app, 5)
    for (let i = 0; i < 3; i++) {
      await app.mockMouse.scroll(x, y, "down")
      await frames(app, 2)
    }
    await frames(app, 20)

    // Input has stopped: neither the view nor the selection may keep moving.
    const top = scroll.scrollTop
    const count = moves.length
    await frames(app, 30)
    expect(scroll.scrollTop).toBe(top)
    expect(moves.length).toBe(count)
    // And the wheel did scroll the list.
    expect(top).toBeGreaterThan(0)
  } finally {
    app.renderer.destroy()
  }
})

test("arrow keys after wheel scrolling move on from the hovered row and stay put", async () => {
  await using tmp = await tmpdir()
  const moves: string[] = []
  const app = await mountList(tmp.path, moves)

  try {
    await frames(app, 5)
    await wait(() => findScrollBox(app.renderer.root) !== undefined)
    const scroll = findScrollBox(app.renderer.root)!
    const x = scroll.x + 6
    const y = scroll.y + 2

    await app.mockMouse.moveTo(x, y)
    await frames(app, 5)
    await app.mockMouse.scroll(x, y, "down")
    await frames(app, 5)
    const hovered = moves.at(-1)!

    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    await frames(app, 20)
    const index = Number(hovered.split(".")[1])
    expect(moves.at(-1)).toBe(`key.${index + 2}`)

    const top = scroll.scrollTop
    const count = moves.length
    await frames(app, 30)
    expect(scroll.scrollTop).toBe(top)
    expect(moves.length).toBe(count)
  } finally {
    app.renderer.destroy()
  }
})
