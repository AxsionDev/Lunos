import { RGBA, TextAttributes } from "@opentui/core"
import { createMemo, For } from "solid-js"
import { tint, useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { createPulse } from "../util/signal"
import { splash } from "../logo"

// Fixed brand palette for the splash (Catppuccin Mocha values from the approved
// mockup) — deliberately independent of the user's selected TUI theme, so the
// splash reads the same regardless of which of the 30+ themes is active.
function withAlpha(color: RGBA, alpha: number): RGBA {
  return RGBA.fromValues(color.r, color.g, color.b, alpha)
}

const MOON_COLOR = RGBA.fromHex("#fdf3d0")
const REFLECTION_COLOR = RGBA.fromHex("#c9bd93")
const WATER_LIGHT = RGBA.fromHex("#8fb4dd")
const WATER_COLOR = RGBA.fromHex("#5f8fc7")
const WATER_DARK = RGBA.fromHex("#3d5f8f")
const CLOUD_COLOR = withAlpha(RGBA.fromHex("#b7c2e0"), 0.75)

// The reflection inset sits centered under the moon, woven into the water
// row directly beneath it rather than rendered as a separate line.
const WATER_SIDE_WIDTH = Math.floor((splash.waterWidth - splash.reflectionWidth) / 2)
const WATER_SIDE_REMAINDER = splash.waterWidth - splash.reflectionWidth - WATER_SIDE_WIDTH

export function Logo() {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const reflectionAlpha = createPulse(animationsEnabled)
  const glow = createMemo(() => tint(theme.background, MOON_COLOR, 0.12))

  return (
    <box alignItems="center">
      <box backgroundColor={glow()} paddingLeft={1} paddingRight={1}>
        <text fg={MOON_COLOR} attributes={TextAttributes.BOLD}>
          {splash.wordmark}
        </text>
      </box>
      <box flexDirection="row" alignItems="flex-end" gap={2}>
        <box alignSelf="flex-start" flexDirection="column">
          <For each={splash.cloud}>
            {(line) => (
              <text fg={CLOUD_COLOR} wrapMode="none">
                {line}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="column">
          <For each={splash.moon}>
            {(line) => (
              <text fg={MOON_COLOR} wrapMode="none">
                {line}
              </text>
            )}
          </For>
        </box>
        <box alignSelf="flex-start" flexDirection="column">
          <For each={splash.cloud}>
            {(line) => (
              <text fg={CLOUD_COLOR} wrapMode="none">
                {line}
              </text>
            )}
          </For>
        </box>
      </box>
      <box flexDirection="column">
        <text fg={WATER_LIGHT} wrapMode="none">
          {"~".repeat(splash.waterWidth)}
        </text>
        <box flexDirection="row">
          <text fg={WATER_COLOR} wrapMode="none">
            {"~".repeat(WATER_SIDE_WIDTH)}
          </text>
          <text fg={withAlpha(REFLECTION_COLOR, reflectionAlpha())} wrapMode="none">
            {"≈".repeat(splash.reflectionWidth)}
          </text>
          <text fg={WATER_COLOR} wrapMode="none">
            {"~".repeat(WATER_SIDE_REMAINDER)}
          </text>
        </box>
        <text fg={WATER_COLOR} wrapMode="none">
          {"~".repeat(splash.waterWidth)}
        </text>
        <text fg={WATER_DARK} wrapMode="none">
          {"~".repeat(splash.waterWidth)}
        </text>
      </box>
    </box>
  )
}
