import { TuiConfig } from "@opencode-ai/tui/config"
import { isRecord } from "@opencode-ai/tui/util/record"
import { Filesystem } from "@/util/filesystem"
import { Schema } from "effect"

export function resolveHostAttentionSoundPaths(
  root: string,
  sounds: unknown,
  options?: { trim?: boolean },
): TuiConfig.AttentionSoundPaths {
  if (!isRecord(sounds)) return {}
  return Object.fromEntries(
    Object.entries(sounds).flatMap(([name, file]) => {
      if (!Schema.is(TuiConfig.AttentionSoundName)(name)) return []
      if (typeof file !== "string") return []
      const value = options?.trim ? file.trim() : file
      if (!value) return []
      // XCOD-311: a bundled sound ID ("alert-04") or "none" isn't a file next to tui.json.
      if (TuiConfig.isNamedSound(value)) return [[name, value.trim()]]
      return [[name, Filesystem.resolveFilePath(root, value)]]
    }),
  )
}
