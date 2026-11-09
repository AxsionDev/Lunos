import { VoiceDictation } from "@opencode-ai/core/voice/dictation"
import type { VoiceRecorder } from "@opencode-ai/core/voice/recorder"
import { VoiceWav } from "@opencode-ai/core/voice/wav"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { voiceButtonShown } from "./voice-shown"

// XCOD-336: the desktop prompt's mic button. Hold it to talk and let go to transcribe, or click once
// to start and again to stop; Esc cancels. The microphone is read with Web Audio into memory, and
// whisper.cpp transcribes in the desktop app's main process (platform.voice), on this computer. The
// web app has no platform.voice, so no button: its server may be on another machine.

const BARS = 10

export function PromptVoiceButton(props: { insert: (text: string) => void; submit: () => void; disabled?: boolean }) {
  const platform = usePlatform()
  const serverSync = useServerSync()
  const language = useLanguage()
  const config = createMemo(() => serverSync().data.config.voice)
  const voice = platform.voice
  const shown = createMemo(() => voiceButtonShown({ local: !!voice, config: config() }))
  const [store, setStore] = createStore({
    phase: "idle" as VoiceDictation.Phase,
    levels: [] as number[],
    started: 0,
    now: 0,
    download: undefined as number | undefined,
  })
  const state = {
    ready: false,
    down: false,
    checking: undefined as Promise<"now" | "later" | "no"> | undefined,
    pending: undefined as ReturnType<typeof setTimeout> | undefined,
  }

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("prompt.voice.error", { error: error instanceof Error ? error.message : String(error) }),
    })

  const dictation = VoiceDictation.create({
    releases: true,
    recorder: (options) => record(options.onLevel ?? (() => {})),
    transcribe: (pcm) => voice!.transcribe(pcm, { model: config()?.model, language: config()?.language }),
    onStatus: (status) =>
      setStore({
        phase: status.phase,
        started: status.started,
        levels: status.phase === "recording" ? [...store.levels.slice(-(BARS - 1)), status.level] : [],
      }),
    onText: (text) => {
      props.insert(text)
      const seconds = config()?.auto_send ?? 0
      if (seconds > 0) state.pending = setTimeout(props.submit, seconds * 1000)
    },
    onError: fail,
  })

  const ticker = setInterval(() => {
    if (store.phase !== "recording") return
    dictation.tick()
    setStore("now", Date.now())
  }, 50)
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && store.phase === "recording") {
      event.preventDefault()
      event.stopPropagation()
      dictation.cancel()
    }
    // Typing after the transcript went in cancels the automatic send.
    if (state.pending && event.key !== "Escape") {
      clearTimeout(state.pending)
      state.pending = undefined
    }
  }
  window.addEventListener("keydown", escape, true)
  onCleanup(() => {
    clearInterval(ticker)
    window.removeEventListener("keydown", escape, true)
    dictation.cancel()
    if (state.pending) clearTimeout(state.pending)
  })

  // Another model in config: check (and offer to download) it on the next press.
  createEffect(() => {
    config()?.model
    state.ready = false
  })

  /** "now": ready without asking anything, so this press records; "later": the user was asked. */
  async function ready(): Promise<"now" | "later" | "no"> {
    const status = await voice!.status(config()?.model)
    if (!status.whisper) {
      showToast({ variant: "error", title: language.t("prompt.voice.missing"), duration: 10000 })
      return "no"
    }
    if (!(await voice!.microphone())) {
      showToast({ variant: "error", title: language.t("prompt.voice.micDenied"), duration: 10000 })
      return "no"
    }
    if (status.model) return "now"
    if (status.offline) {
      showToast({ variant: "error", title: language.t("prompt.voice.offline"), duration: 10000 })
      return "no"
    }
    const agreed = await new Promise<boolean>((resolve) =>
      showToast({
        persistent: true,
        title: language.t("prompt.voice.download.title"),
        description: language.t("prompt.voice.download.message", {
          model: config()?.model ?? "base",
          size: String(Math.round(status.size / 1_000_000)),
        }),
        actions: [
          { label: language.t("prompt.voice.download.confirm"), onClick: () => resolve(true) },
          { label: language.t("common.cancel"), onClick: () => resolve(false) },
        ],
      }),
    )
    if (!agreed) return "no"
    setStore("download", 0)
    const done = await voice!
      .download(config()?.model, (percent) => setStore("download", percent))
      .then(() => true)
      .catch((error: unknown) => {
        fail(error)
        return false
      })
    setStore("download", undefined)
    return done ? "later" : "no"
  }

  const press = (event: PointerEvent) => {
    event.preventDefault()
    state.down = true
    if (store.download !== undefined) return
    if (state.ready) return dictation.press()
    // The first press checks the setup once. When nothing had to be asked, the same press records
    // (and a button already let go counts as a click).
    if (state.checking) return
    state.checking = ready().catch((error: unknown) => {
      fail(error)
      return "no" as const
    })
    void state.checking.then((result) => {
      state.checking = undefined
      state.ready = result !== "no"
      if (result !== "now") return
      dictation.press()
      if (!state.down) dictation.release()
    })
  }

  const release = () => {
    state.down = false
    dictation.release()
  }

  const seconds = () => Math.max(0, Math.floor((store.now - store.started) / 1000))
  const label = () => {
    if (store.download !== undefined)
      return language.t("prompt.voice.download.progress", { percent: String(store.download) })
    if (store.phase === "recording") return language.t("prompt.voice.recording")
    if (store.phase === "transcribing") return language.t("prompt.voice.transcribing")
    return language.t("prompt.voice.start")
  }

  return (
    <Show when={shown()}>
      <div class="flex items-center gap-1.5">
        <Show when={store.phase === "recording"}>
          <div class="flex items-end gap-px h-4" aria-hidden="true">
            {Array.from({ length: BARS }, (_, index) => (
              <span
                class="w-0.5 rounded-full bg-text-base"
                style={{ height: `${Math.max(2, Math.round((store.levels[index] ?? 0) * 16))}px` }}
              />
            ))}
          </div>
          <span class="text-12-regular tabular-nums text-text-weak">
            {Math.floor(seconds() / 60)}:{String(seconds() % 60).padStart(2, "0")}
          </span>
        </Show>
        <Tooltip placement="top" value={label()}>
          <Button
            data-action="prompt-voice"
            type="button"
            variant="ghost"
            class="size-8 p-0"
            classList={{ "text-text-critical-base": store.phase === "recording" }}
            disabled={props.disabled || store.phase === "transcribing"}
            aria-label={label()}
            aria-pressed={store.phase === "recording"}
            onPointerDown={press}
            onPointerUp={release}
          >
            <svg viewBox="0 0 20 20" class="size-4.5" fill="none" aria-hidden="true">
              <rect x="7" y="2.5" width="6" height="10" rx="3" stroke="currentColor" />
              <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" stroke="currentColor" stroke-linecap="round" />
            </svg>
          </Button>
        </Tooltip>
      </div>
    </Show>
  )
}

/** The microphone through Web Audio at 16 kHz, kept in memory; the recorder interface is synchronous. */
function record(onLevel: (level: number) => void): VoiceRecorder.Recording {
  const chunks: Int16Array[] = []
  const state = { cancelled: false }
  const opened = navigator.mediaDevices
    .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    .then((stream) => {
      const context = new AudioContext({ sampleRate: VoiceWav.RATE })
      const source = context.createMediaStreamSource(stream)
      // ScriptProcessor rather than an AudioWorklet: no module URL to load under the app's CSP.
      const node = context.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = (event) => {
        if (state.cancelled) return
        const chunk = VoiceWav.fromFloat(event.inputBuffer.getChannelData(0))
        chunks.push(chunk)
        onLevel(VoiceWav.level(chunk))
      }
      source.connect(node)
      node.connect(context.destination)
      return () => {
        node.disconnect()
        source.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        void context.close()
      }
    })
  // A refused microphone is reported by stop(); don't let it surface as an unhandled rejection first.
  opened.catch(() => {})
  return {
    async stop() {
      const close = await opened
      close()
      return VoiceWav.concat(chunks.splice(0))
    },
    cancel() {
      state.cancelled = true
      chunks.splice(0)
      void opened.then((close) => close()).catch(() => {})
    },
  }
}
