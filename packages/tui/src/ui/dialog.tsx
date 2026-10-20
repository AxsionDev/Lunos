import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createContext, createEffect, onCleanup, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { useTheme } from "../context/theme"
import { EditBufferRenderable, MouseButton, Renderable, RGBA } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { Flag } from "@opencode-ai/core/flag/flag"
import { useBindings, useOpencodeModeStack } from "../keymap"
import { useClipboard } from "../context/clipboard"

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge"
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()

  let dismiss = false
  const width = () => {
    if (props.size === "xlarge") return 116
    if (props.size === "large") return 88
    return 60
  }

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      zIndex={3000}
      paddingTop={dimensions().height / 4}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => {
          // A selection release must bubble up to the copy-on-select handler in
          // DialogProvider; the backdrop's dismiss flag keeps it from closing the dialog.
          if (renderer.getSelection()?.getSelectedText()) return
          dismiss = false
          e.stopPropagation()
        }}
        width={width()}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

/**
 * XCOD-233: screens reachable from /settings form one window. Esc closes all of it from any depth;
 * ← goes back one level (`back`). A screen opened with `back` (or `nav`) is part of that window,
 * and so is anything a window screen opens with a plain `replace` (it inherits the way back).
 * Screens opened elsewhere keep the old behaviour: Esc pops them.
 */
export type DialogNav = {
  /** Where ← goes. Unset on the window's top level, where ← does nothing. */
  back?: () => void
  /** Part of the /settings window even without a way back (its top level). */
  nav?: boolean
  /**
   * What Esc does instead of closing the window: a window opened over another screen (/memory's
   * Change storage…) goes back to it.
   */
  escape?: () => void
  /**
   * `generation` when the opener was set up. A replace from a flow that was still running when the
   * window was closed (a save that finished after Esc) is dropped instead of reopening it.
   */
  generation?: number
}

type Entry = {
  element: JSX.Element
  onClose?: () => void
  nav?: boolean
  back?: () => void
  escape?: () => void
}

/** A focused text field whose cursor isn't at its start: ← belongs to it, not to navigation. */
function editingText(focused: unknown) {
  return focused instanceof EditBufferRenderable && !focused.isDestroyed && focused.cursorOffset > 0
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as Entry[],
    size: "medium" as "medium" | "large" | "xlarge",
    generation: 0,
  })

  const renderer = useRenderer()
  const modeStack = useOpencodeModeStack()

  createEffect(() => {
    if (store.stack.length === 0) return
    const popMode = modeStack.push("modal")
    onCleanup(popMode)
  })

  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  /** Closes the whole /settings window: nothing a pending prompt or save would do happens. */
  function closeAll() {
    setStore("generation", (value) => value + 1)
    api.clear()
  }

  /** ← on a window screen: back one level. False when there's nowhere to go back to. */
  function back() {
    const current = store.stack.at(-1)
    if (!current?.back) return false
    current.back()
    return true
  }

  useBindings(() => ({
    enabled: store.stack.length > 0 && !renderer.getSelection()?.getSelectedText(),
    // Above the text fields' own layers, so ← at the start of a field goes back (XCOD-233).
    priority: 2,
    bindings: [
      {
        key: "escape",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          const current = store.stack.at(-1)
          if (current?.escape) return current.escape()
          if (current?.nav) return closeAll()
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
      {
        key: "left",
        desc: "Back",
        group: "Dialog",
        cmd: (ctx: { focused: unknown }) => {
          const current = store.stack.at(-1)
          // Not ours: the key goes on to the focused field (moves its cursor) or the screen.
          if (!current?.back || editingText(ctx.focused ?? renderer.currentFocusedRenderable)) return false
          back()
        },
      },
      {
        key: "ctrl+c",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
    ],
  }))

  const api = {
    clear() {
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("size", "medium")
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: any, onClose?: () => void, nav?: DialogNav) {
      if (nav?.generation !== undefined && nav.generation !== store.generation) return
      const top = store.stack.at(-1)
      const entry: Entry = { element: input, onClose }
      if (nav && (nav.back || nav.nav)) {
        entry.nav = true
        entry.back = nav.back
        entry.escape = nav.escape
      } else if (top?.nav) {
        entry.nav = true
        entry.back = top.back
        entry.escape = top.escape
      }
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setStore("size", "medium")
      setStore("stack", [entry])
    },
    /** Esc's meaning for the current screen, also used by the "esc" labels and the backdrop. */
    dismiss() {
      const current = store.stack.at(-1)
      if (current?.escape) return current.escape()
      if (current?.nav) return closeAll()
      api.clear()
    },
    back,
    /** Makes the screen shown the top level of the /settings window (opened by a plain replace). */
    markNav() {
      const index = store.stack.length - 1
      if (index >= 0 && !store.stack[index].nav) setStore("stack", index, "nav", true)
    },
    /** Bumped each time the /settings window is closed with Esc (see DialogNav.generation). */
    get generation() {
      return store.generation
    },
    /** Whether the screen shown is part of the /settings window, and whether it can go back. */
    get nav() {
      const top = store.stack.at(-1)
      return top?.nav ? { back: top.back !== undefined } : undefined
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    setSize(size: "medium" | "large" | "xlarge") {
      setStore("size", size)
    },
  }
  return api
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const clipboard = useClipboard()

  function copySelection() {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text || !clipboard.write) return false
    void clipboard.write(text).then(
      () => toast.show({ message: "Copied to clipboard", variant: "info" }),
      (error) => toast.error(error),
    )
    renderer.clearSelection()
    return true
  }

  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt: { button: number; preventDefault(): void; stopPropagation(): void }) => {
          if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!copySelection()) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? copySelection : undefined}
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.dismiss()} size={value.size}>
            {value.stack.at(-1)!.element}
            <Show when={value.nav}>{(nav) => <NavHint back={nav().back} />}</Show>
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

/** XCOD-233: the same two keys on every screen of the /settings window. */
function NavHint(props: { back: boolean }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} flexShrink={0}>
      <text fg={theme.textMuted}>{props.back ? "← back · esc close" : "esc close"}</text>
    </box>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}
