import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { newVersionNotice } from "@opencode-ai/core/installation/version"
import { useTheme } from "../context/theme"

/**
 * XCOD-147: the bottom-right "There is a new version" line, on every screen. `version` comes from
 * this session's update check only, so with checks off (autoupdate false, offline, disabled by
 * env or policy) nothing is shown, even if an earlier session saw a newer version.
 */
export function UpdateNotice(props: { version: string | undefined }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={props.version}>
      {(version) => (
        <box flexDirection="row" justifyContent="flex-end" flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text fg={theme.warning} wrapMode="none">
            {newVersionNotice(version(), dimensions().width)}
          </text>
        </box>
      )}
    </Show>
  )
}
