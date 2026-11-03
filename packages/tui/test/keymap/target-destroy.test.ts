import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Keymap, type KeymapHost } from "@opentui/keymap"
import { registerDefaultKeys } from "@opentui/keymap/addons"
import { shareTargetDestroy } from "../../src/keymap-host"

// A host whose targets are EventEmitters, as opentui's Renderables are.
function fakeHost(): KeymapHost<EventEmitter> & { destroyed: boolean } {
  const root = new EventEmitter()
  return {
    destroyed: false,
    get isDestroyed() {
      return this.destroyed
    },
    metadata: { platform: "linux", primaryModifier: "ctrl", modifiers: {} } as any,
    rootTarget: root,
    getFocusedTarget: () => null,
    getParentTarget: () => null,
    isTargetDestroyed: () => false,
    onKeyPress: () => () => {},
    onKeyRelease: () => () => {},
    onFocusChange: () => () => {},
    onTargetDestroy(target: EventEmitter, listener: () => void) {
      target.once("destroyed", listener)
      return () => target.off("destroyed", listener)
    },
    createCommandEvent: () => ({}) as any,
  } as any
}

describe("XCOD-341: one destroy listener per target", () => {
  test("16 layers on one target add one listener and no MaxListeners warning", () => {
    const warnings: string[] = []
    const onWarning = (w: Error) => warnings.push(w.name)
    process.on("warning", onWarning)
    try {
      const target = new EventEmitter()
      const keymap = new Keymap(shareTargetDestroy(fakeHost()))
      registerDefaultKeys(keymap)
      const dispose = Array.from({ length: 16 }, (_, i) =>
        keymap.registerLayer({ target, targetMode: "focus-within", bindings: [{ key: `f${i + 1}`, cmd: () => {} }] }),
      )
      expect(target.listenerCount("destroyed")).toBe(1)
      for (const item of dispose) item()
      // Every layer gone: the shared listener goes too.
      expect(target.listenerCount("destroyed")).toBe(0)
    } finally {
      process.off("warning", onWarning)
    }
    expect(warnings).not.toContain("MaxListenersExceededWarning")
  })

  test("destroying the target removes every layer bound to it, once", () => {
    const target = new EventEmitter()
    const host = shareTargetDestroy(fakeHost())
    const calls: number[] = []
    host.onTargetDestroy(target, () => calls.push(1))
    const off = host.onTargetDestroy(target, () => calls.push(2))
    host.onTargetDestroy(target, () => calls.push(3))
    off()
    target.emit("destroyed")
    target.emit("destroyed")
    expect(calls).toEqual([1, 3])
    expect(target.listenerCount("destroyed")).toBe(0)
    // A target reused after destroy gets a fresh listener.
    host.onTargetDestroy(target, () => calls.push(4))
    target.emit("destroyed")
    expect(calls).toEqual([1, 3, 4])
  })

  test("the wrapped host's getters stay live", () => {
    const base = fakeHost()
    const host = shareTargetDestroy(base)
    expect(host.isDestroyed).toBe(false)
    base.destroyed = true
    expect(host.isDestroyed).toBe(true)
  })
})
