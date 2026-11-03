import type { CliRenderer } from "@opentui/core"
import { Keymap, type KeymapEvent, type KeymapHost } from "@opentui/keymap"
import { registerDefaultKeys, registerEnabledFields, registerMetadataFields } from "@opentui/keymap/addons"
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui"

/**
 * XCOD-341: the keymap adds one "destroyed" listener to a renderable for each layer bound to it, and
 * the prompt's textarea has 16 layers (paste, clear, Esc, undo, history, voice, autocomplete …). Past
 * Node's default of 10 listeners, Bun printed "MaxListenersExceededWarning … 11 destroyed listeners"
 * straight over the TUI. It isn't a leak (each layer removes its listener when it goes), so rather
 * than raise the limit, which would hide a real leak, every target gets one shared listener.
 */
export function shareTargetDestroy<TTarget extends object, TEvent extends KeymapEvent>(
  host: KeymapHost<TTarget, TEvent>,
): KeymapHost<TTarget, TEvent> {
  const targets = new WeakMap<TTarget, { listeners: Set<() => void>; off: () => void }>()
  const onTargetDestroy = (target: TTarget, listener: () => void) => {
    let entry = targets.get(target)
    if (!entry) {
      const listeners = new Set<() => void>()
      const off = host.onTargetDestroy(target, () => {
        targets.delete(target)
        for (const item of [...listeners]) item()
      })
      entry = { listeners, off }
      targets.set(target, entry)
    }
    // A wrapper, so the same function registered for two layers is two entries, as with `once`.
    const item = () => listener()
    entry.listeners.add(item)
    const current = entry
    return () => {
      if (!current.listeners.delete(item) || current.listeners.size > 0) return
      if (targets.get(target) === current) targets.delete(target)
      current.off()
    }
  }
  // Delegates to the host, so its getters (isDestroyed, metadata) stay live; copying them would freeze them.
  const shared: KeymapHost<TTarget, TEvent> = Object.create(host)
  shared.onTargetDestroy = onTargetDestroy
  return shared
}

/** createDefaultOpenTuiKeymap from @opentui/keymap/opentui, with one destroy listener per target. */
export function createOpencodeKeymap(renderer: CliRenderer) {
  if (renderer.isDestroyed) throw new Error("Cannot create a keymap for a destroyed renderer")
  const keymap = new Keymap(shareTargetDestroy(createOpenTuiKeymapHost(renderer)))
  registerDefaultKeys(keymap)
  registerEnabledFields(keymap)
  registerMetadataFields(keymap)
  return keymap
}
