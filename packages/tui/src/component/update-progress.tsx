import { Show, createSignal, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { upgradeProgressText, type UpgradeStep } from "@opencode-ai/core/installation/version"
import { useTheme } from "../context/theme"
import { useAnimationsEnabled } from "../context/motion"
import { Spinner } from "./spinner"

export type UpgradeProgress = { step: UpgradeStep; version: string; started: number; stepStarted: number }

/**
 * XCOD-247: the running update, in the bottom-right corner where the update notice sits, so the
 * prompt stays usable while the package manager works. The step is always written out, so it isn't
 * carried by the animation alone (XCOD-141); with reduced motion it's a static "Updating… (step)".
 */
export function UpdateProgress(props: { progress: UpgradeProgress | undefined }) {
  const { theme } = useTheme()
  const animations = useAnimationsEnabled()
  const dimensions = useTerminalDimensions()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const text = (progress: UpgradeProgress) =>
    upgradeProgressText(
      progress.step,
      progress.version || undefined,
      now() - progress.stepStarted,
      now() - progress.started,
    )

  return (
    <Show when={props.progress}>
      {(progress) => (
        <box
          flexDirection="row"
          justifyContent="flex-end"
          flexShrink={0}
          paddingLeft={2}
          paddingRight={2}
          maxWidth={dimensions().width}
        >
          <Show
            when={animations()}
            fallback={
              <text fg={theme.warning} wrapMode="none">
                {`Updating… (${text(progress())})`}
              </text>
            }
          >
            <Spinner color={theme.warning}>{text(progress())}</Spinner>
          </Show>
        </box>
      )}
    </Show>
  )
}
