import { TextAttributes } from "@opentui/core"
import { createSignal, For, Show } from "solid-js"
import { useAccount } from "../context/account"
import { useExit } from "../context/exit"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DISABLED_TITLE, disabledLines } from "../util/account"
import { selectionMarker } from "../util/status-glyph"

// XCOD-312: the notice for a disabled Lunos account. Full-screen, in front of the app, in the Welcome
// screen's style. It says why (the category, never the free-text reason), until when, and whom to
// ask. Past sessions stay readable: "View past sessions" leaves it for the app, where the prompt
// refuses new prompts (and so does the session loop).

export const COPY = {
  lead: "You can't send new prompts with it. Your past sessions on this computer stay readable.",
} as const

type Action = { id: string; label: string; run: () => void }

export function DisabledAccount() {
  const account = useAccount()
  const host = account.host!
  const { theme } = useTheme()
  const dialog = useDialog()
  const exit = useExit()
  const [focus, setFocus] = createSignal(0)

  const actions = (): Action[] => [
    { id: "view", label: "View past sessions (read-only)", run: () => account.viewReadOnly() },
    // Lifted by Lunos support: a new sign-in clears the notice.
    {
      id: "signin",
      label: "Sign in again",
      run: () => void host.logout().then(() => account.signedOut()),
    },
    { id: "exit", label: "Exit", run: () => exit() },
  ]

  const move = (delta: number) => setFocus((focus() + delta + actions().length) % actions().length)

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "down", desc: "Next", group: "Account disabled", cmd: () => move(1) },
      { key: "tab", desc: "Next", group: "Account disabled", cmd: () => move(1) },
      { key: "up", desc: "Previous", group: "Account disabled", cmd: () => move(-1) },
      { key: "shift+tab", desc: "Previous", group: "Account disabled", cmd: () => move(-1) },
      { key: "return", desc: "Choose", group: "Account disabled", cmd: () => actions()[focus()]?.run() },
    ],
  }))

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" paddingLeft={2} paddingRight={2}>
      <box width="100%" maxWidth={90} flexDirection="column" gap={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.error}>
          {DISABLED_TITLE}
        </text>
        <box flexDirection="column">
          <For each={disabledLines(account.disabled() ?? {})}>
            {(line) => (
              <text fg={theme.text} wrapMode="word">
                {line}
              </text>
            )}
          </For>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          {COPY.lead}
        </text>
        <Show when={account.user()}>
          {(user) => <text fg={theme.textMuted}>Signed in as {user().email ?? user().name ?? user().sub}</text>}
        </Show>
        <box flexDirection="column">
          <For each={actions()}>
            {(action, index) => {
              const active = () => index() === focus()
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setFocus(index())
                    action.run()
                  }}
                >
                  <text fg={active() ? theme.selectedListItemText : theme.text}>
                    {selectionMarker(active())}
                    {action.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <text fg={theme.textMuted}>↑↓ move · enter choose</text>
      </box>
    </box>
  )
}
