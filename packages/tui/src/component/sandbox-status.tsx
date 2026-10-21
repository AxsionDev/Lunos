import { createMemo, Match, Show, Switch } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useSandbox } from "../context/sandbox"
import { useTheme } from "../context/theme"
import { requiredBanner, statusLine } from "../util/sandbox"

/**
 * XCOD-281: where the sandbox is, on every screen. "Sandbox starting… (step)", then "Sandbox ready ·
 * <id>"; "no sandbox · …" with Retry while it's off after a failure; under sandbox.required, a banner
 * that says why nothing can run, with Retry and Open log.
 */
export function SandboxStatus(props: { retry: () => void; openLog: () => void }) {
  const sandbox = useSandbox()
  const { theme } = useTheme()
  const line = createMemo(() => statusLine(sandbox.state()))
  const blocked = createMemo(() => {
    const state = sandbox.state()
    return state?.status === "blocked" ? state.failure : undefined
  })
  const color = () => {
    const status = sandbox.state()?.status
    if (status === "off") return theme.warning
    if (status === "failed") return theme.error
    return theme.textMuted
  }

  return (
    <Switch>
      <Match when={blocked()}>
        {(failure) => (
          <box
            flexShrink={0}
            marginLeft={2}
            marginRight={2}
            paddingLeft={1}
            paddingRight={1}
            border={["left"]}
            borderColor={theme.error}
          >
            <text fg={theme.text} wrapMode="word">
              {requiredBanner(failure())}
            </text>
            <box flexDirection="row" gap={2}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={props.retry}>
                [Retry]
              </text>
              <Show when={failure().log}>
                <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={props.openLog}>
                  [Open log]
                </text>
              </Show>
              <text fg={theme.textMuted}>/sandbox-retry · /logs</text>
            </box>
          </box>
        )}
      </Match>
      <Match when={line()}>
        {(text) => (
          <box flexShrink={0} height={1} paddingLeft={2} paddingRight={2} flexDirection="row" gap={1}>
            <text fg={color()} wrapMode="none">
              {text()}
            </text>
            <Show when={sandbox.state()?.status === "off"}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={props.retry}>
                · Retry
              </text>
              <text fg={theme.textMuted}>(/sandbox-retry)</text>
            </Show>
          </box>
        )}
      </Match>
    </Switch>
  )
}
