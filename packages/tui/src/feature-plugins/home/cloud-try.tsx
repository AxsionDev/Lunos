import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, Show } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { useBindings } from "../../keymap"
import { useAccount } from "../../context/account"
import { useProject } from "../../context/project"
import { useSandbox } from "../../context/sandbox"
import { useTheme } from "../../context/theme"
import { loginIsLocal } from "../../util/external-login"
import { DISMISSED, offered, runOnTerminal } from "../../util/cloud-try"

// XCOD-317: "Try Lunos Cloud" on the home screen, once after sign-in: /cloud runs the same guided
// path as `lunos cloud quickstart` (it is that command, on this terminal), /cloud-hide hides it.
// Either one dismisses it for good, on this machine only (kv); nothing is sent anywhere for it.

const id = "internal:home-cloud-try"

function View(props: { api: TuiPluginApi }) {
  const theme = useTheme().theme
  const account = useAccount()
  const project = useProject()
  const sandbox = useSandbox()
  const directory = () => project.instance.path().directory
  // Only where the TUI's server runs here as this user: the run starts from this machine's checkout.
  const local = createMemo(() =>
    loginIsLocal({ sandbox: !!sandbox.host, serverHome: project.instance.path().home, home: Global.Path.home }),
  )
  const [command] = createResource(
    () => (account.user() && local() && directory() ? directory() : undefined),
    (dir) => account.host?.quickstart?.(dir).catch(() => undefined),
  )
  const dismissed = createMemo(() => props.api.kv.get<boolean>(DISMISSED, false) === true)
  const show = createMemo(() =>
    offered({ signedIn: !!account.user(), dismissed: dismissed(), local: local(), command: !!command() }),
  )
  const hide = () => props.api.kv.set(DISMISSED, true)

  useBindings(() => ({
    enabled: show,
    commands: [
      {
        name: "cloud.try",
        title: "Try Lunos Cloud: your first cloud run",
        category: "System",
        namespace: "palette",
        slashName: "cloud",
        async run() {
          const cmd = command()
          props.api.ui.dialog.clear()
          if (!cmd) return
          hide()
          await runOnTerminal({ command: cmd, renderer: props.api.renderer, cwd: directory() })
        },
      },
      {
        name: "cloud.try.hide",
        title: "Hide “Try Lunos Cloud”",
        category: "System",
        namespace: "palette",
        slashName: "cloud-hide",
        run() {
          hide()
          props.api.ui.dialog.clear()
        },
      },
    ],
  }))

  return (
    <Show when={show()}>
      <box width="100%" maxWidth={75} paddingTop={1} flexDirection="row" flexShrink={1}>
        <text flexShrink={0} style={{ fg: theme.primary }}>
          ● Try Lunos Cloud{" "}
        </text>
        <text style={{ fg: theme.textMuted }}>
          run a first task in the cloud and get its results branch: /cloud (or /cloud-hide)
        </text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: {
      home_bottom() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
