// XCOD-307: hiding the right pane (the session sidebar, the Agent Monitor's session list) with one
// obvious action: `»` at its top hides it, `«` at the bottom-right brings it back and carries a
// badge while something in it needs you. The rules are in util/right-pane.ts.
import { batch, createMemo, createSignal, Show, type Accessor } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useCommandShortcut } from "../keymap"
import * as RightPane from "../util/right-pane"

/** The keybind that hides and shows the pane, from config ("ctrl+x b"). */
export function usePaneShortcut() {
  return useCommandShortcut("session.sidebar.toggle")
}

/**
 * A view's pane: its remembered choice (kv.json, under `key`), whether it's open for now, and where
 * it is. `toggle` is the one action the keybind, the command palette, » and « all run.
 */
export function useRightPane(input: { key: Accessor<string>; wide: Accessor<boolean>; none?: Accessor<boolean> }) {
  const kv = useKV()
  const pref = createMemo(() => RightPane.pane(kv.get(input.key())))
  const [open, setOpen] = createSignal(false)
  const state = createMemo(() => ({ pref: pref(), open: open(), wide: input.wide() }))
  const placement = createMemo(() => (input.none?.() ? "hidden" : RightPane.placement(state())))
  return {
    pref,
    placement,
    visible: () => placement() !== "hidden",
    /** The columns the conversation gives up. */
    taken: () => (placement() === "docked" ? RightPane.PANE_WIDTH : 0),
    toggle() {
      const next = RightPane.toggled(state())
      batch(() => {
        if (next.pref !== pref()) kv.set(input.key(), next.pref)
        setOpen(next.open)
      })
    },
  }
}

/** `»` at the pane's top-right, which hides it, with the keybind beside it: not the glyph alone. */
export function PaneHide(props: { onHide: () => void; label?: string }) {
  const { theme } = useTheme()
  const shortcut = usePaneShortcut()
  const [hover, setHover] = createSignal(false)
  return (
    <box flexDirection="row" justifyContent="flex-end" flexShrink={0}>
      <text
        fg={hover() ? theme.text : theme.textMuted}
        wrapMode="none"
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => props.onHide()}
      >
        {props.label ?? "hide pane"}
        {shortcut() ? ` ${shortcut()}` : ""} <span style={{ fg: theme.text }}>»</span>
      </text>
    </box>
  )
}

/**
 * `«` at the bottom-right while the pane is hidden. With something in it that needs you, a coloured
 * dot and the count; pointing at it says what, in words (`label`).
 */
export function PaneChip(props: { count: number; label: string; onOpen: () => void; title?: string }) {
  const { theme } = useTheme()
  const shortcut = usePaneShortcut()
  const [hover, setHover] = createSignal(false)
  return (
    <box position="absolute" bottom={0} right={2} flexDirection="row" zIndex={10}>
      <text
        fg={theme.textMuted}
        wrapMode="none"
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => props.onOpen()}
      >
        <span style={{ fg: theme.text }}>«</span> {props.title ?? "show pane"}
        {shortcut() ? ` ${shortcut()}` : ""}
        <Show when={props.count > 0}>
          {" "}
          <span style={{ fg: theme.warning }}>●</span>{" "}
          <span style={{ fg: theme.warning }}>
            {hover() && props.label ? (
              props.label
            ) : (
              <>
                <b>{props.count}</b> {props.count === 1 ? "needs you" : "need you"}
              </>
            )}
          </span>
        </Show>
      </text>
    </box>
  )
}
