import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"
import { useTuiConfig } from "../config"

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const commandShortcut = useCommandShortcut("command.palette.show")
  const undoShortcut = useCommandShortcut("input.undo")
  const tuiConfig = useTuiConfig()

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Press {commandShortcut()} to see all available actions and commands in any context.
        </text>
      </box>
      <Show when={tuiConfig.double_escape_clear}>
        <box paddingBottom={1}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.text }}>esc esc</span> clears the prompt; {undoShortcut()} right after brings it
            back.
          </text>
        </box>
      </Show>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
