import type { KeyEvent, Renderable, TextareaRenderable } from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { VoiceDictation } from "@opencode-ai/core/voice/dictation"
import { VoiceModels } from "@opencode-ai/core/voice/models"
import { VoiceRecorder } from "@opencode-ai/core/voice/recorder"
import { VoiceWhisper } from "@opencode-ai/core/voice/whisper"
import { Show, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { useTuiConfig } from "../../config"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"

// XCOD-336: push-to-talk dictation into the prompt. The microphone is read by a system recorder
// (VoiceRecorder) and the speech turned into text by whisper.cpp, both in this process, on this
// computer: the audio is held in memory and dropped after transcription, never written to disk,
// sent to the server, logged or shown to telemetry. The transcript is inserted for editing; it's
// only sent by itself when `voice.auto_send` is set and the user leaves it alone that long.

const BARS = "▁▂▃▄▅▆▇█"

type Ready = "now" | "later" | "no"

export function usePromptVoice(props: {
  target: Accessor<TextareaRenderable | undefined>
  text: Accessor<string>
  enabled: Accessor<boolean>
  submit: () => void
}) {
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const dialog = useDialog()
  const config = createMemo(() => sync.data.config.voice)
  // An organisation turns this off with `voice.enabled: false` (lockable): no key, no hint.
  const allowed = createMemo(() => config()?.enabled !== false)
  const [status, setStatus] = createSignal<VoiceDictation.Status>({ phase: "idle", level: 0, started: 0 })
  const [levels, setLevels] = createSignal<number[]>([])
  const [now, setNow] = createSignal(Date.now())
  const [download, setDownload] = createSignal<number>()
  const state = {
    ready: false,
    checking: undefined as Promise<Ready> | undefined,
    binary: "",
    pending: undefined as { text: string; timer: ReturnType<typeof setTimeout> } | undefined,
  }

  const model = () => config()?.model ?? VoiceModels.DEFAULT

  const dictation = VoiceDictation.create({
    recorder: (options) => VoiceRecorder.start(options),
    transcribe: (pcm) =>
      VoiceWhisper.transcribe(pcm, {
        binary: state.binary,
        model: VoiceModels.file(model()),
        language: config()?.language,
      }),
    onStatus: (next) => {
      setStatus(next)
      if (next.phase === "recording") setLevels((all) => [...all.slice(-11), next.level])
      if (next.phase !== "recording") setLevels([])
    },
    onText: insert,
    onError: (error) => toast.show({ variant: "error", title: "Voice input", message: error.message, duration: 8000 }),
  })

  const timer = setInterval(() => {
    if (status().phase !== "recording") return
    dictation.tick()
    setNow(Date.now())
  }, 50)
  onCleanup(() => {
    clearInterval(timer)
    dictation.cancel()
    if (state.pending) clearTimeout(state.pending.timer)
  })

  function insert(text: string) {
    const input = props.target()
    if (!input || input.isDestroyed) return
    const before = props.text()
    input.insertText((before && !/\s$/.test(before) ? " " : "") + text)
    const seconds = config()?.auto_send ?? 0
    if (seconds <= 0) return
    if (state.pending) clearTimeout(state.pending.timer)
    state.pending = {
      text: input.plainText,
      timer: setTimeout(() => {
        state.pending = undefined
        props.submit()
      }, seconds * 1000),
    }
  }

  // Another model in config: check (and offer to download) it on the next press.
  createEffect(() => {
    model()
    state.ready = false
  })

  // Any edit after the transcript went in cancels the automatic send.
  createEffect(() => {
    const text = props.text()
    if (!state.pending || text === state.pending.text) return
    clearTimeout(state.pending.timer)
    state.pending = undefined
  })

  /** "now": ready without asking anything, so this press records; "later": the user was asked. */
  async function ready(): Promise<Ready> {
    const binary = VoiceWhisper.find()
    if (!binary) {
      toast.show({
        variant: "warning",
        title: "Voice input needs whisper.cpp",
        message: whisperHint(),
        duration: 10000,
      })
      return "no"
    }
    state.binary = binary
    if (await VoiceModels.installed(model())) return "now"
    const spec = VoiceModels.MODELS[model()]
    const yes = await DialogConfirm.show(
      dialog,
      "Download the speech model?",
      [
        `Voice input transcribes on this computer with whisper.cpp's ${model()} model (${Math.round(spec.size / 1_000_000)} MB).`,
        `Download it once from huggingface.co/ggerganov/whisper.cpp? It is checked against its pinned SHA-256 and kept in ${VoiceModels.dir()}.`,
        "Your voice is never sent anywhere: only this model file is downloaded.",
      ].join("\n\n"),
    )
    if (!yes) return "no"
    setDownload(0)
    const done = await VoiceModels.download(model(), {
      onProgress: (progress) => setDownload(Math.floor((progress.received / progress.total) * 100)),
    })
      .then(() => true)
      .catch((error: Error) => {
        toast.show({ variant: "error", title: "Voice model download", message: error.message, duration: 10000 })
        return false
      })
      .finally(() => setDownload(undefined))
    if (!done) return "no"
    toast.show({ variant: "success", message: "Voice input is ready: press the key again and speak", duration: 5000 })
    return "later"
  }

  function press(ctx: CommandContext<Renderable, KeyEvent>) {
    ctx.event.preventDefault()
    ctx.event.stopPropagation()
    if (download() !== undefined) return
    if (state.ready) return dictation.press(ctx.event.repeated === true)
    // The first press checks the setup once (repeats while it runs are ignored). When nothing had
    // to be asked, the same press records.
    if (state.checking) return
    state.checking = ready()
    void state.checking.then((result) => {
      state.checking = undefined
      state.ready = result !== "no"
      if (result === "now") dictation.press()
    })
  }

  // One binding set (the prompt already carries many on its textarea). Esc while recording cancels
  // it and drops the audio, before Esc means anything else.
  useBindings(() => {
    const keys = props.enabled() && allowed()
    const recording = status().phase === "recording"
    return {
      target: props.target,
      enabled: props.target() !== undefined && (keys || recording),
      priority: 20,
      bindings: [
        ...(keys ? tuiConfig.keybinds.get("prompt.voice").map((binding) => ({ ...binding, cmd: press })) : []),
        ...(recording
          ? [{ key: "escape", desc: "Cancel voice input", group: "Prompt", cmd: () => dictation.cancel() }]
          : []),
      ],
    }
  })

  const View = () => {
    const { theme } = useTheme()
    const seconds = () => Math.max(0, Math.floor((now() - status().started) / 1000))
    const meter = () =>
      levels()
        .map((level) => BARS[Math.min(BARS.length - 1, Math.floor(level * BARS.length))])
        .join("")
        .padEnd(12, BARS[0])
    return (
      <Show when={allowed() && (status().phase !== "idle" || download() !== undefined)}>
        <box flexDirection="row" gap={1} paddingTop={1} flexShrink={0}>
          <Show when={download() !== undefined}>
            <text fg={theme.textMuted}>Downloading the speech model… {download()}%</text>
          </Show>
          <Show when={status().phase === "recording"}>
            <text fg={theme.error}>● rec</text>
            <text fg={theme.text}>
              {Math.floor(seconds() / 60)}:{String(seconds() % 60).padStart(2, "0")}
            </text>
            <text fg={theme.primary}>{meter()}</text>
            <text fg={theme.textMuted}>release or press again to transcribe · esc cancel</text>
          </Show>
          <Show when={status().phase === "transcribing"}>
            <text fg={theme.textMuted}>Transcribing on this computer…</text>
          </Show>
        </box>
      </Show>
    )
  }

  return { View, allowed }
}

function whisperHint() {
  if (process.platform === "darwin") return "Install it with: brew install whisper-cpp (and ffmpeg for the microphone)"
  if (process.platform === "win32")
    return "Download whisper-bin-x64.zip from github.com/ggml-org/whisper.cpp/releases, and put whisper-cli.exe on your PATH"
  return "Install whisper.cpp (whisper-cli) from your distribution or build it from github.com/ggml-org/whisper.cpp"
}
