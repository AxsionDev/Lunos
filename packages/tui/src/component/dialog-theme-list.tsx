import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useTheme, resolveTheme, type Theme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { onCleanup } from "solid-js"
import { useTuiConfig } from "../config"
import { useSDK } from "../context/sdk"

function ThemeSwatch(props: { current: boolean; resolved?: Theme }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text flexShrink={0}>{props.current ? "●" : " "}</text>
      <box width={2} height={1} flexShrink={0} backgroundColor={props.resolved?.background} />
      <box width={2} height={1} flexShrink={0} backgroundColor={props.resolved?.primary} />
      <box width={2} height={1} flexShrink={0} backgroundColor={props.resolved?.accent} />
    </box>
  )
}

/** `onPick` (XCOD-128, /settings) is called with the confirmed theme, which then saves it to tui.json. */
export function DialogThemeList(props: { onPick?: (theme: string) => void } = {}) {
  const theme = useTheme()
  const tuiConfig = useTuiConfig()
  const sdk = useSDK()
  const initial = theme.selected
  const all = theme.all()
  const mode = theme.mode()
  const options = Object.keys(all)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((value) => {
      // Custom themes are user-authored files and may have unresolvable color refs;
      // fall back to a blank swatch for that one entry rather than failing the whole dialog.
      const resolved = (() => {
        try {
          return resolveTheme(all[value], mode)
        } catch {
          return undefined
        }
      })()
      return {
        title: value,
        value: value,
        gutter: () => <ThemeSwatch current={value === initial} resolved={resolved} />,
      }
    })
  const dialog = useDialog()
  let confirmed = false
  let ref: DialogSelectRef<string>

  onCleanup(() => {
    if (!confirmed) theme.set(initial)
  })

  return (
    <DialogSelect
      title="Themes"
      options={options}
      current={initial}
      onMove={(opt) => {
        theme.set(opt.value)
      }}
      onSelect={(opt) => {
        theme.set(opt.value)
        confirmed = true
        if (props.onPick) return props.onPick(opt.value)
        // A theme in tui.json wins over this pick on the next start; keep the file in step, or the
        // pick would silently revert (XCOD-128 writes the theme there).
        if (tuiConfig.theme !== undefined && tuiConfig.theme !== opt.value)
          void sdk.client.config
            .settingsSet({ settingsSetInput: { key: "tui.theme", value: opt.value, scope: "user" } })
            .catch(() => {})
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          theme.set(initial)
          return
        }

        const first = ref.filtered[0]
        if (first) theme.set(first.value)
      }}
    />
  )
}
