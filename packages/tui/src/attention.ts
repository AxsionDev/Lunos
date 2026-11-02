/// <reference path="./audio.d.ts" />
import type {
  TuiAttention,
  TuiAttentionNotifyInput,
  TuiAttentionNotifyResult,
  TuiAttentionNotifySkipReason,
  TuiAttentionWhen,
  TuiKV,
  TuiAttentionSoundName,
  TuiAttentionSoundPack,
  TuiAttentionSoundPackInfo,
} from "@opencode-ai/plugin/tui"
import { AttentionSoundName, type TuiConfig } from "./config"
import { Schema } from "effect"
import stripAnsi from "strip-ansi"
import * as TuiAudio from "./audio"
import { DEFAULT_SOUNDS, NO_SOUND, clampVolume, isSoundID } from "@opencode-ai/ui/sounds"
import { SOUND_FILES } from "./sounds"

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
  triggerNotification(message: string, title?: string): boolean
}

type RegisteredSoundPack = TuiAttentionSoundPack & {
  builtin: boolean
}

type TuiAttentionHost = TuiAttention & {
  /**
   * XCOD-311: plays one sound for the settings' preview, at the configured volume (or `volume`),
   * whether or not alerts are on. `sound` is a bundled ID or a file. Resolves to a stop function.
   */
  preview(sound: string, volume?: number): Promise<(() => void) | undefined>
  /** What an event plays when nothing is chosen for it: the active pack's sound, else the built-in. */
  packSound(name: TuiAttentionSoundName): string
  dispose(): void
}

let active: TuiAttentionHost | undefined

/** XCOD-311: the running app's attention, for /settings (preview, packs) and the mute command. */
export function currentAttention() {
  return active
}

const DEFAULT_TITLE = "Lunos"
// Persisted in user config under `attention.sound_pack`; renaming it would
// orphan existing configs, so the id stays even though the label is rebranded.
const DEFAULT_PACK_ID = "opencode.default"
const KV_SOUND_PACK = "attention_sound_pack"
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240
const BUILTIN_PACK: RegisteredSoundPack = {
  id: DEFAULT_PACK_ID,
  name: "Lunos Default",
  builtin: true,
  // XCOD-311: by bundled sound ID (@opencode-ai/ui/sounds), so the settings can name each default.
  sounds: DEFAULT_SOUNDS,
}

/**
 * XCOD-311: what a configured sound plays. A bundled ID ("alert-04") is its embedded file, `none`
 * is silence (null), anything else is a path. Undefined when nothing is set.
 */
export function soundFile(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (!text) return undefined
  if (text === NO_SOUND) return null
  if (isSoundID(text)) return SOUND_FILES[text]
  return text
}

function skipped(reason: TuiAttentionNotifySkipReason): TuiAttentionNotifyResult {
  return {
    ok: false,
    notification: false,
    sound: false,
    skipped: reason,
  }
}

function normalizeText(input: string | undefined, fallback: string, limit: number) {
  const text = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  const normalized = text.length ? text : fallback
  return Array.from(normalized).slice(0, limit).join("")
}

function soundVolume(input: TuiAttentionNotifyInput, config: Pick<TuiConfig.Resolved, "attention">) {
  if (!config.attention.sound) return
  if (input.sound === false) return
  const volume = clampVolume(
    typeof input.sound === "object" ? (input.sound.volume ?? config.attention.volume) : config.attention.volume,
  )
  // XCOD-311: at 0% nothing plays, rather than a silent voice that reports a sound was made.
  return volume > 0 ? volume : undefined
}

function normalizePack(pack: TuiAttentionSoundPack): RegisteredSoundPack | undefined {
  const id = pack.id.trim()
  if (!id) return
  return {
    id,
    name: pack.name?.trim() || undefined,
    builtin: false,
    sounds: Object.fromEntries(
      Object.entries(pack.sounds).filter(
        (item): item is [TuiAttentionSoundName, string] =>
          Schema.is(AttentionSoundName)(item[0]) && typeof item[1] === "string" && item[1].trim().length > 0,
      ),
    ),
  }
}

function focusSkip(when: TuiAttentionWhen, focus: FocusState) {
  if (when === "always") return
  if (focus === "unknown") return "focus_unknown"
  if (when === "blurred" && focus === "focused") return "focused"
  if (when === "focused" && focus === "blurred") return "blurred"
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<TuiConfig.Resolved, "attention">
  kv?: TuiKV
  audio?: Pick<typeof TuiAudio, "loadSoundFile" | "play"> & Partial<Pick<typeof TuiAudio, "stopVoice">>
}): TuiAttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false
  let activePackID: string | undefined
  const packs = new Map<string, RegisteredSoundPack>([[BUILTIN_PACK.id, BUILTIN_PACK]])
  const audio = input.audio ?? TuiAudio

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  function configuredPackID() {
    const stored = input.kv?.get<string | undefined>(KV_SOUND_PACK, undefined)
    return activePackID ?? stored ?? input.config.attention.sound_pack
  }

  function currentPack() {
    return packs.get(configuredPackID()) ?? BUILTIN_PACK
  }

  function soundCandidates(name: TuiAttentionSoundName) {
    // The first choice that says anything decides; `none` there means silence, not "try the next".
    const list = [input.config.attention.sounds[name], currentPack().sounds[name], BUILTIN_PACK.sounds[name]].map(
      soundFile,
    )
    if (list.find((item) => item !== undefined) === null) return []
    return list.filter((item, index): item is string => typeof item === "string" && list.indexOf(item) === index)
  }

  async function playSound(name: TuiAttentionSoundName, volume: number) {
    try {
      for (const file of soundCandidates(name)) {
        const current = await audio.loadSoundFile(file).catch((error) => {
          console.debug("failed to load attention sound", { file, error })
          return null
        })
        if (disposed) return false
        if (current == null) continue
        if (audio.play(current, { volume }) != null) return true
      }
      return false
    } catch (error) {
      console.debug("failed to play attention sound", { error })
      return false
    }
  }

  const host: TuiAttentionHost = {
    async notify(request) {
      try {
        if (!input.config.attention.enabled) return skipped("attention_disabled")
        if (disposed || input.renderer.isDestroyed) return skipped("renderer_destroyed")

        const message = normalizeText(request.message, "", MESSAGE_LIMIT)
        if (!message) return skipped("empty_message")

        const requestedNotification = typeof request.notification === "object" ? request.notification : undefined
        const notificationSkip = focusSkip(requestedNotification?.when ?? "blurred", focus)
        const notificationRequested = input.config.attention.notifications && request.notification !== false
        const shouldNotify = notificationRequested && !notificationSkip
        const notification = shouldNotify
          ? (() => {
              try {
                return input.renderer.triggerNotification(
                  message,
                  normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT),
                )
              } catch (error) {
                console.debug("failed to trigger attention notification", { error })
                return false
              }
            })()
          : false
        const volume = soundVolume(request, input.config)
        const requestedSound = typeof request.sound === "object" ? request.sound : undefined
        const soundSkip = volume === undefined ? undefined : focusSkip(requestedSound?.when ?? "always", focus)
        const soundName =
          requestedSound?.name && Schema.is(AttentionSoundName)(requestedSound.name) ? requestedSound.name : "default"
        const sound = volume === undefined || soundSkip ? false : await playSound(soundName, volume)

        if (!notification && !sound) {
          if (notificationRequested && notificationSkip) return skipped(notificationSkip)
          if (soundSkip) return skipped(soundSkip)
        }

        return {
          ok: notification || sound,
          notification,
          sound,
        }
      } catch (error) {
        console.debug("failed to handle attention notification", { error })
        return {
          ok: false,
          notification: false,
          sound: false,
        }
      }
    },
    soundboard: {
      registerPack(pack) {
        const next = normalizePack(pack)
        if (!next) return () => {}
        packs.set(next.id, next)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          if (packs.get(next.id) === next) packs.delete(next.id)
        }
      },
      activate(id, options) {
        const pack = packs.get(id)
        if (!pack) return false
        activePackID = pack.id
        if (options?.persist) input.kv?.set(KV_SOUND_PACK, pack.id)
        return true
      },
      current() {
        return currentPack().id
      },
      list(): TuiAttentionSoundPackInfo[] {
        const current = currentPack().id
        return Array.from(packs.values()).map((pack) => ({
          id: pack.id,
          name: pack.name,
          active: pack.id === current,
          builtin: pack.builtin,
        }))
      },
    },
    async preview(sound, volume) {
      const file = soundFile(sound)
      const level = clampVolume(volume ?? input.config.attention.volume)
      if (!file || level <= 0 || disposed) return undefined
      const loaded = await audio.loadSoundFile(file).catch(() => null)
      if (!loaded || disposed) return undefined
      const voice = audio.play(loaded, { volume: level })
      if (voice == null) return undefined
      return () => void audio.stopVoice?.(voice)
    },
    packSound(name) {
      return currentPack().sounds[name] ?? BUILTIN_PACK.sounds[name]!
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (active === host) active = undefined
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
    },
  }
  active = host
  return host
}
