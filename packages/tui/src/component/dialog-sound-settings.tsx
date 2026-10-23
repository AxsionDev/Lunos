import type { SettingRow } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { stepVolume } from "@opencode-ai/ui/sounds"
import type { TuiAttentionSoundName } from "@opencode-ai/plugin/tui"
import { currentAttention } from "../attention"
import * as TuiAudio from "../audio"
import { useTheme } from "../context/theme"
import { useDialog, type DialogNav } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { checkSoundFile } from "../util/sound-file"
import { createSoundPreview } from "../util/sound-preview"
import * as SoundSettings from "../util/sound-settings"

// XCOD-311: the editors of Settings › Notifications & sounds that a plain enum or text prompt
// can't be: volume (previews at the new level), the sound pack (built-in, or any a plugin
// registered) and each event's sound (previews the highlighted one; None, Custom file…, Reset).

type Save = (row: SettingRow, value: string, options?: { reopen?: boolean; unset?: boolean }) => Promise<boolean>

/** The sound an event plays when nothing is chosen for it, by the active pack. */
export function packSound(event: string) {
  return currentAttention()?.packSound(event as TuiAttentionSoundName)
}

/** A sound pack's name, for the row and the picker. */
export function packName(id: string) {
  const pack = currentAttention()
    ?.soundboard.list()
    .find((item) => item.id === id)
  if (!pack) return undefined
  return pack.builtin ? "Built-in" : (pack.name ?? pack.id)
}

/** Previews with the running app's attention; stops when the picker closes. */
function usePreview(player: (sound: string) => Promise<(() => void) | undefined>) {
  const preview = createSoundPreview(player)
  onCleanup(preview.stop)
  return preview
}

const play = async (sound: string, volume?: number) => (await currentAttention()?.preview(sound, volume)) ?? undefined

/**
 * The first highlight a picker reports is its current value on opening, not a move: that one
 * doesn't play, so opening a picker is silent.
 */
function afterFirst<T>(fn: (value: T) => void) {
  let first = true
  return (value: T) => {
    if (first) {
      first = false
      return
    }
    fn(value)
  }
}

function VolumePicker(props: { row: SettingRow; current: number; onPick: (volume: number) => void }) {
  // At each level, the finished sound. What's previewed is the level, so moving through levels debounces.
  const preview = usePreview((volume) => play(packSound("done") ?? "bip-bop-01", Number(volume)))
  const move = afterFirst((volume: number) => preview.play(volume > 0 ? String(volume) : undefined))
  return (
    <DialogSelect<number>
      title={props.row.label}
      skipFilter
      current={stepVolume(props.current)}
      options={SoundSettings.VOLUME_STEPS.map((volume) => ({
        title: SoundSettings.percent(volume),
        value: volume,
        footer: volume === 0 ? "silent" : volume === 0.4 ? "default" : undefined,
      }))}
      onMove={(option) => move(option.value)}
      onSelect={(option) => {
        preview.stop()
        props.onPick(option.value)
      }}
    />
  )
}

function EventSoundPicker(props: {
  row: SettingRow
  current?: string
  packDefault?: string
  onPick: (value: string) => void
}) {
  const preview = usePreview((sound) => play(sound))
  const isSound = (value: string) => value !== SoundSettings.CUSTOM_FILE && value !== SoundSettings.PACK_DEFAULT
  const move = afterFirst((value: string) =>
    preview.play(
      value === SoundSettings.PACK_DEFAULT ? props.packDefault : isSound(value) && value !== "none" ? value : undefined,
    ),
  )
  return (
    <DialogSelect<string>
      title={props.row.label}
      placeholder="Type to filter sounds"
      current={props.current ?? props.packDefault}
      options={SoundSettings.soundChoices({ current: props.current, packDefault: props.packDefault })}
      onMove={(option) => move(option.value)}
      onSelect={(option) => {
        preview.stop()
        props.onPick(option.value)
      }}
    />
  )
}

/** Handles the rows of this section that need more than the generic editors; false for the rest. */
export function useSoundSettingsEditor(input: {
  save: Save
  reopen: (key?: string) => void
  backTo: (key: string) => DialogNav
}) {
  const dialog = useDialog()
  const { theme } = useTheme()

  async function customFile(row: SettingRow, previous?: string) {
    let value = previous && !previous.startsWith("+") ? previous : ""
    let error: string | undefined
    while (true) {
      const message = error
      const typed = await DialogPrompt.show(dialog, `${row.label}: custom file`, {
        value,
        placeholder: "/path/to/sound.mp3",
        description: () =>
          message ? (
            <text fg={theme.error} wrapMode="word">
              {message}. The event keeps its sound.
            </text>
          ) : (
            <text fg={theme.textMuted} wrapMode="word">
              The path to an .mp3, .aac or .wav file. It's checked before it's saved.
            </text>
          ),
        nav: input.backTo(row.key),
      })
      if (typed === null) return input.reopen(row.key)
      const check = await checkSoundFile(typed, {
        // Decoded once, never played; skipped when this terminal has no audio.
        decode: async (file) => (TuiAudio.available() ? (await TuiAudio.loadSoundFile(file)) !== null : undefined),
      })
      if (check.ok) return void input.save(row, check.file, { reopen: true })
      value = typed
      error = check.error
    }
  }

  function edit(row: SettingRow) {
    if (!row.key.startsWith(SoundSettings.PREFIX)) return false
    if (row.key === SoundSettings.PREFIX + "volume") {
      dialog.replace(
        () => (
          <VolumePicker
            row={row}
            current={typeof row.value === "number" ? row.value : 0.4}
            onPick={(volume) => void input.save(row, String(volume), { reopen: true })}
          />
        ),
        undefined,
        input.backTo(row.key),
      )
      return true
    }
    if (row.key === SoundSettings.PREFIX + "sound_pack") {
      const packs = currentAttention()?.soundboard.list() ?? []
      dialog.replace(
        () => (
          <DialogSelect<string>
            title={row.label}
            skipFilter
            current={typeof row.value === "string" ? row.value : "opencode.default"}
            options={packs.map((pack) => ({
              title: pack.builtin ? "Built-in" : (pack.name ?? pack.id),
              value: pack.id,
              footer: pack.builtin ? "Lunos's own sounds" : pack.id,
            }))}
            onSelect={(option) => void input.save(row, option.value, { reopen: true })}
          />
        ),
        undefined,
        input.backTo(row.key),
      )
      return true
    }
    if (row.key === SoundSettings.PREFIX + "notify_when") {
      dialog.replace(
        () => (
          <DialogSelect<string>
            title={row.label}
            skipFilter
            current={row.value === "always" ? "always" : "blurred"}
            options={[
              { title: "Only when Lunos is in the background", value: "blurred", footer: "default" },
              { title: "Always", value: "always", footer: "even while you're looking at it" },
            ]}
            onSelect={(option) => void input.save(row, option.value, { reopen: true })}
          />
        ),
        undefined,
        input.backTo(row.key),
      )
      return true
    }
    if (row.key.startsWith(SoundSettings.SOUNDS_PREFIX)) {
      const current = row.source !== "default" && typeof row.value === "string" && row.value ? row.value : undefined
      const packDefault = packSound(row.key.slice(SoundSettings.SOUNDS_PREFIX.length))
      dialog.replace(
        () => (
          <EventSoundPicker
            row={row}
            current={current}
            packDefault={packDefault}
            onPick={(value) => {
              if (value === SoundSettings.CUSTOM_FILE) return void customFile(row, current)
              if (value === SoundSettings.PACK_DEFAULT) return void input.save(row, "", { reopen: true, unset: true })
              void input.save(row, value, { reopen: true })
            }}
          />
        ),
        undefined,
        input.backTo(row.key),
      )
      return true
    }
    return false
  }

  return { edit }
}
