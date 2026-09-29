import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useTheme, resolveTheme, type Theme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { onCleanup } from "solid-js"

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

export function DialogThemeList() {
  const theme = useTheme()
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
