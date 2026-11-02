export * as VoiceDictation from "./dictation"

import { VoicePtt } from "./ptt"
import type { VoiceRecorder } from "./recorder"

// XCOD-336: one dictation at a time, from key presses to text. The recorder and the transcriber are
// passed in (the TUI's are ffmpeg/parecord and whisper-cli), so this holds no platform code. The
// samples live in this closure only, between stop and the transcriber's answer.

export type Phase = "idle" | "recording" | "transcribing"

export type Status = { phase: Phase; level: number; started: number }

export type Options = {
  recorder: VoiceRecorder.Recorder
  transcribe: (pcm: Int16Array) => Promise<string>
  onStatus: (status: Status) => void
  onText: (text: string) => void
  onError: (error: Error) => void
  now?: () => number
  /** Recordings shorter than this are dropped as accidental (ms). */
  minimum?: number
  /** The input reports releases (a mouse button): see VoicePtt.create. */
  releases?: boolean
}

export const MINIMUM_MS = 300

export function create(options: Options) {
  const now = options.now ?? Date.now
  const ptt = VoicePtt.create({ releases: options.releases })
  const state = {
    status: { phase: "idle", level: 0, started: 0 } as Status,
    recording: undefined as VoiceRecorder.Recording | undefined,
  }
  const set = (next: Partial<Status>) => {
    state.status = { ...state.status, ...next }
    options.onStatus(state.status)
  }

  const start = () => {
    const recording = (() => {
      try {
        return options.recorder({ onLevel: (level) => state.recording && set({ level }) })
      } catch (error) {
        ptt.reset()
        options.onError(error instanceof Error ? error : new Error(String(error)))
        return
      }
    })()
    if (!recording) return
    state.recording = recording
    set({ phase: "recording", level: 0, started: now() })
  }

  const finish = async () => {
    const recording = state.recording
    if (!recording) return
    state.recording = undefined
    const long = now() - state.status.started >= (options.minimum ?? MINIMUM_MS)
    if (!long) {
      recording.cancel()
      set({ phase: "idle", level: 0 })
      return
    }
    set({ phase: "transcribing", level: 0 })
    const text = await recording
      .stop()
      .then((pcm) => (pcm.length ? options.transcribe(pcm) : ""))
      .catch((error: unknown) => {
        options.onError(error instanceof Error ? error : new Error(String(error)))
        return ""
      })
    set({ phase: "idle" })
    if (text) options.onText(text)
  }

  const act = (action: VoicePtt.Action) => {
    if (action === "start") start()
    if (action === "stop") void finish()
  }

  return {
    get status() {
      return state.status
    },
    press(repeated = false) {
      // While a transcript is on its way, the key does nothing.
      if (state.status.phase === "transcribing") return
      act(ptt.press(now(), repeated))
    },
    release() {
      act(ptt.release(now()))
    },
    tick() {
      act(ptt.tick(now()))
    },
    /** Esc: stop recording and drop the audio. */
    cancel() {
      ptt.reset()
      const recording = state.recording
      state.recording = undefined
      recording?.cancel()
      if (state.status.phase === "recording") set({ phase: "idle", level: 0 })
    },
  }
}
