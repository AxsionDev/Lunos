import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { Tips } from "./tips-view"
import { useBindings } from "../../keymap"
import { useTuiConfig } from "../../config"
import { DialogTips, tipStore } from "../../component/tips"
import { plain } from "../../util/tips"

const id = "internal:home-tips"

function View(props: { api: TuiPluginApi; hidden: boolean; show: boolean; connected: boolean }) {
  useBindings(() => ({
    commands: [
      {
        name: "tips.toggle",
        title: props.hidden ? "Show tips" : "Hide tips",
        category: "System",
        namespace: "palette",
        run() {
          props.api.kv.set("tips_hidden", !props.api.kv.get("tips_hidden", false))
          props.api.ui.dialog.clear()
        },
      },
    ],
    bindings: props.api.tuiConfig.keybinds.get("tips.toggle"),
  }))

  return (
    <box width="100%" maxWidth={75} alignItems="center" paddingTop={3} flexShrink={1}>
      <Show when={props.show}>
        <Tips connected={props.connected} />
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  // XCOD-278: /tips and tips.next work everywhere, not only on the home screen.
  api.keymap.registerLayer({
    commands: [
      {
        name: "tips.list",
        title: "Tips",
        desc: "Every tip, searchable, with the ones you've seen marked",
        category: "System",
        namespace: "palette",
        slashName: "tips",
        run() {
          api.ui.dialog.replace(() => <DialogTips />)
        },
      },
      {
        name: "tips.next",
        title: "Show another tip",
        category: "System",
        namespace: "palette",
        run() {
          api.ui.dialog.clear()
          const store = tipStore()
          if (!store) return
          // On the home screen the tip there changes; elsewhere it shows as a toast.
          if (api.route.current.name === "home") return void store.next("home")
          const text = store.next()
          if (text) api.ui.toast({ title: "Tip", message: plain(text), variant: "info" })
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("tips.palette", ["tips.list", "tips.next"]),
  })

  api.slots.register({
    order: 100,
    slots: {
      home_bottom() {
        const hidden = createMemo(() => api.kv.get("tips_hidden", false))
        const first = createMemo(() => api.state.session.count() === 0)
        const connected = createMemo(() =>
          api.state.provider.some(
            (item) => item.id !== "opencode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
          ),
        )
        const config = useTuiConfig()
        const show = createMemo(() => (!first() || !connected()) && !hidden() && config.tips !== false)
        return <View api={api} hidden={hidden()} show={show()} connected={connected()} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
