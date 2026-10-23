import type { SettingRow } from "@opencode-ai/sdk/v2"
import {
  NO_SOUND,
  SOUND_EVENTS,
  SOUND_FAMILIES,
  SOUND_IDS,
  isSoundID,
  soundLabel,
  stepVolume,
} from "@opencode-ai/ui/sounds"
import path from "node:path"
import type { TuiConfig } from "../config"

// XCOD-311: Settings › Notifications & sounds, the parts that are plain logic: the order of the
// rows, what each shows, the choices of a sound select, and applying a saved value to the running
// app's attention config (read on every alert), so a change is heard without a restart.

export const AREA = "Notifications & sounds"
export const PREFIX = "tui.attention."
export const SOUNDS_PREFIX = "tui.attention.sounds."

/** Picks a file instead of a bundled sound. */
export const CUSTOM_FILE = "+custom"
/** Removes the event's choice, so it plays the sound pack's. */
export const PACK_DEFAULT = "+reset"

const ORDER = [
  "enabled",
  "sound",
  "volume",
  "sound_pack",
  ...SOUND_EVENTS.map((item) => `sounds.${item.id}`),
  "notifications",
  "notify_when",
  "notify_subagents",
].map((key) => PREFIX + key)

/** The section's rows in the order they're listed; the `attention` object itself isn't one. */
export function orderRows<T extends Pick<SettingRow, "key">>(rows: readonly T[]) {
  const rank = (row: T) => {
    const index = ORDER.indexOf(row.key)
    return index < 0 ? ORDER.length : index
  }
  return rows.filter((row) => row.key !== "tui.attention").toSorted((a, b) => rank(a) - rank(b))
}

export const VOLUME_STEPS = Array.from({ length: 11 }, (_, index) => index / 10)

export function percent(volume: number) {
  return `${Math.round(stepVolume(volume) * 100)}%`
}

/** "Alert 04", "None", "Custom: chime.wav". */
export function describeSound(value: string | undefined) {
  if (!value) return ""
  if (value === NO_SOUND) return "None"
  if (isSoundID(value)) return soundLabel(value)
  return `Custom: ${path.basename(value)}`
}

/** What a row of this section shows on the right, in words rather than raw config values. */
export function display(
  row: Pick<SettingRow, "key" | "value" | "display" | "source">,
  context: { packSound?: (event: string) => string | undefined; packName?: (id: string) => string | undefined },
) {
  if (row.key === PREFIX + "volume") return typeof row.value === "number" ? percent(row.value) : row.display
  if (row.key === PREFIX + "notify_when") return row.value === "always" ? "always" : "in the background"
  if (row.key === PREFIX + "sound_pack")
    return context.packName?.(String(row.value ?? "")) ?? (row.value === "opencode.default" ? "Built-in" : row.display)
  if (row.key.startsWith(SOUNDS_PREFIX)) {
    if (row.source !== "default" && typeof row.value === "string" && row.value) return describeSound(row.value)
    const fallback = context.packSound?.(row.key.slice(SOUNDS_PREFIX.length))
    return fallback ? `${describeSound(fallback)} (default)` : "pack default"
  }
  return row.display
}

export type SoundChoice = { title: string; value: string; category?: string; footer?: string }

/** None, every bundled sound by family, Custom file… and Reset to pack default. */
export function soundChoices(input: { current?: string; packDefault?: string }): SoundChoice[] {
  const custom = input.current && input.current !== NO_SOUND && !isSoundID(input.current) ? input.current : undefined
  const mark = (value: string) => (value === input.packDefault ? "pack default" : undefined)
  return [
    { title: "None", value: NO_SOUND, footer: "silent" },
    ...SOUND_IDS.map((id) => ({
      title: soundLabel(id),
      value: id,
      category: SOUND_FAMILIES.find((family) => id.startsWith(family.id + "-"))?.label,
      footer: mark(id),
    })),
    {
      title: "Custom file…",
      value: CUSTOM_FILE,
      category: "Other",
      footer: custom ? path.basename(custom) : ".mp3, .aac or .wav",
    },
    {
      title: "Reset to pack default",
      value: PACK_DEFAULT,
      category: "Other",
      footer: input.packDefault ? describeSound(input.packDefault) : undefined,
    },
  ]
}

type Attention = TuiConfig.Resolved["attention"]

const DEFAULTS: Omit<Attention, "sounds"> = {
  enabled: false,
  notifications: true,
  sound: true,
  volume: 0.4,
  sound_pack: "opencode.default",
  notify_when: "blurred",
  notify_subagents: false,
}

/**
 * Applies a value saved to `tui.attention.<key>` (undefined when it was removed) to the running
 * app's resolved config, in place: the attention host and the notifications read it on every alert.
 */
export function apply(attention: Attention, key: string, value: unknown) {
  if (!key.startsWith(PREFIX)) return
  const field = key.slice(PREFIX.length)
  if (field.startsWith("sounds.")) {
    const event = field.slice("sounds.".length) as keyof Attention["sounds"]
    const sounds = { ...attention.sounds }
    if (typeof value === "string" && value) sounds[event] = value
    else delete sounds[event]
    attention.sounds = sounds
    return
  }
  if (!(field in DEFAULTS)) return
  const name = field as keyof typeof DEFAULTS
  const fallback = DEFAULTS[name]
  const next = value === undefined || typeof value !== typeof fallback ? fallback : value
  ;(attention as Record<string, unknown>)[name] = name === "volume" ? stepVolume(next as number) : next
}
