import { ipcMain, systemPreferences } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { MODELS, type Model } from "@opencode-ai/core/config/voice"
import { Offline } from "@opencode-ai/core/offline"
import { VoiceModels } from "@opencode-ai/core/voice/models"
import { VoiceWhisper } from "@opencode-ai/core/voice/whisper"
import type { VoiceStatus } from "../preload/types"

// XCOD-336: voice input in the desktop app. The renderer records the microphone with Web Audio and
// hands the samples over IPC; this process runs whisper.cpp on them, on this computer. The samples
// are never written to disk, sent to the server or logged, and neither is the transcript.

const model = (value: unknown): Model => (MODELS.includes(value as Model) ? (value as Model) : VoiceModels.DEFAULT)

export function registerVoiceHandlers() {
  ipcMain.handle("voice-status", async (_event: IpcMainInvokeEvent, name: unknown): Promise<VoiceStatus> => {
    const chosen = model(name)
    return {
      whisper: !!VoiceWhisper.find(),
      model: await VoiceModels.installed(chosen),
      size: VoiceModels.MODELS[chosen].size,
      offline: Offline.enabled(),
    }
  })

  // Only after the user agreed in the renderer; progress goes back to the window that asked.
  ipcMain.handle("voice-download", async (event: IpcMainInvokeEvent, name: unknown) => {
    await VoiceModels.download(model(name), {
      onProgress: (progress) => {
        if (event.sender.isDestroyed()) return
        event.sender.send("voice-download-progress", Math.floor((progress.received / progress.total) * 100))
      },
    })
  })

  ipcMain.handle(
    "voice-transcribe",
    async (_event: IpcMainInvokeEvent, pcm: unknown, options: { model?: unknown; language?: unknown }) => {
      if (!(pcm instanceof ArrayBuffer) && !ArrayBuffer.isView(pcm)) throw new Error("Invalid audio")
      const binary = VoiceWhisper.find()
      if (!binary) throw new Error("whisper.cpp (whisper-cli) is not installed")
      const chosen = model(options?.model)
      if (!(await VoiceModels.installed(chosen))) throw new Error("The speech model is not installed")
      const samples = pcm instanceof ArrayBuffer ? new Int16Array(pcm) : new Int16Array(pcm.buffer.slice(0))
      return VoiceWhisper.transcribe(samples, {
        binary,
        model: VoiceModels.file(chosen),
        language: typeof options?.language === "string" ? options.language : undefined,
      })
    },
  )

  // macOS asks once per app (NSMicrophoneUsageDescription); elsewhere the OS decides at capture.
  ipcMain.handle("voice-mic-access", async () => {
    if (process.platform !== "darwin") return true
    if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true
    return systemPreferences.askForMediaAccess("microphone")
  })
}
