import { createEffect, createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useKV } from "../../context/kv"
import { useSync } from "../../context/sync"
import { TipText, useTipStore } from "../../component/tips"

const NO_MODELS_TIP = "Run {highlight}/providers{/highlight} to add an AI provider and start coding"

/** XCOD-278: the home screen's tip, a new one from the deck each time home shows. */
export function Tips(props: { connected?: boolean }) {
  const theme = useTheme().theme
  const kv = useKV()
  const sync = useSync()
  const store = useTipStore()
  const [drawn, setDrawn] = createSignal(false)
  // Drawn once, when kv has loaded (a draw before that would write over the stored deck) and the
  // config is in, so the tip's conditions are read from the real settings.
  createEffect(() => {
    if (drawn() || !kv.ready || sync.status !== "complete" || props.connected === false) return
    store.next("home")
    setDrawn(true)
  })
  // `tips.next` replaces store.home() while this shows.
  const text = () => (props.connected === false ? NO_MODELS_TIP : drawn() ? store.home() : undefined)

  return (
    <Show when={text()}>
      {(value) => (
        <box flexDirection="row" maxWidth="100%">
          <text flexShrink={0} style={{ fg: theme.warning }}>
            ● Tip{" "}
          </text>
          <TipText text={value()} />
        </box>
      )}
    </Show>
  )
}
