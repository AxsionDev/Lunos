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

/**
 * `onPick` (XCOD-128, /settings) is called with the confirmed theme, which then saves it to tui.json.
 * `forProject` (XCOD-306, project settings): the pick is only handed to `onPick`; nothing global
 * changes.
 */
export function DialogThemeList(
  props: { onPick?: (theme: string) => void; forProject?: boolean; title?: string; current?: string } = {},
) {
  const theme = useTheme()
  const tuiConfig = useTuiConfig()
  const sdk = useSDK()
  const initial = theme.shown
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
  let ref: DialogSelectRef<string>

  // XCOD-306: moving through the list previews a theme without choosing it, over a project's theme.
  // Once a theme is picked or the list is closed, late list events (a filter cleared as the input
  // goes away) must not bring a preview back.
  let closed = false
  const preview = (name: string | undefined) => {
    if (!closed) theme.preview(name)
  }
  const close = () => {
    closed = true
    theme.preview(undefined)
  }
  onCleanup(close)

  /** For all projects: the global theme, as /theme always set it. */
  function setGlobal(value: string) {
    theme.set(value)
    // A theme in tui.json wins over this pick on the next start; keep the file in step, or the
    // pick would silently revert (XCOD-128 writes the theme there).
    if (tuiConfig.theme !== undefined && tuiConfig.theme !== value)
      void sdk.client.config
        .settingsSet({ settingsSetInput: { key: "tui.theme", value, scope: "user" } })
        .catch(() => {})
  }

  return (
    <DialogSelect
      title={props.title ?? "Themes"}
      options={options}
      current={props.current ?? initial}
      onMove={(opt) => {
        preview(opt.value)
      }}
      onSelect={(opt) => {
        close()
        if (props.forProject) return props.onPick?.(opt.value)
        if (props.onPick) {
          theme.set(opt.value)
          return props.onPick(opt.value)
        }
        // XCOD-306: in a project's session, "this project only" or "all projects".
        const project = theme.project()
        if (!project || theme.projectTheme()?.source === "locked") {
          setGlobal(opt.value)
          return dialog.clear()
        }
        const picked = opt.value
        dialog.replace(() => (
          <DialogSelect<"project" | "all">
            title={`Set ${picked} for`}
            skipFilter
            options={[
              { title: "This project only", value: "project", description: `${project.name}, on this computer only` },
              { title: "All projects", value: "all", description: "your theme everywhere else" },
            ]}
            onSelect={(answer) => {
              if (answer.value === "project") theme.setPersonal(project.key, picked)
              else {
                setGlobal(picked)
                // Otherwise this project's own theme would still hide the change here.
                theme.setPersonal(project.key, undefined)
              }
              dialog.clear()
            }}
          />
        ))
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          preview(undefined)
          return
        }

        const first = ref.filtered[0]
        if (first) preview(first.value)
      }}
    />
  )
}
