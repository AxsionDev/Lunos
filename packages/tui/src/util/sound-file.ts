import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SOUND_FILE_EXTENSIONS } from "@opencode-ai/ui/sounds"

// XCOD-311: Settings › Notifications & sounds › Custom file…. The path is checked before it's
// saved, so an unreadable file is refused where it was typed and the event keeps its old sound.

export type SoundFileCheck = { ok: true; file: string } | { ok: false; error: string }

/** `~/x.mp3` and relative paths, as the absolute path that is saved. */
export function soundFilePath(input: string, cwd = process.cwd(), home = os.homedir()) {
  const text = input.trim().replace(/^file:\/\//, "")
  if (text === "~") return home
  if (text.startsWith("~/")) return path.join(home, text.slice(2))
  return path.resolve(cwd, text)
}

/**
 * `decode` tries to load the file as a sound without playing it: false when it can't be decoded,
 * undefined when there's no audio to try with (then only the file itself is checked).
 */
export async function checkSoundFile(
  input: string,
  options: { cwd?: string; home?: string; decode?: (file: string) => Promise<boolean | undefined> } = {},
): Promise<SoundFileCheck> {
  if (!input.trim()) return { ok: false, error: "Type the path to a sound file" }
  const file = soundFilePath(input, options.cwd, options.home)
  const ext = path.extname(file).toLowerCase()
  if (!(SOUND_FILE_EXTENSIONS as readonly string[]).includes(ext))
    return { ok: false, error: `${path.basename(file)} isn't an .mp3, .aac or .wav file` }
  const info = await stat(file).catch(() => undefined)
  if (!info) return { ok: false, error: `No file at ${file}` }
  if (!info.isFile()) return { ok: false, error: `${file} is a folder, not a sound file` }
  if (info.size === 0) return { ok: false, error: `${file} is empty` }
  const readable = await access(file, constants.R_OK)
    .then(() => true)
    .catch(() => false)
  if (!readable) return { ok: false, error: `Lunos can't read ${file}` }
  if ((await options.decode?.(file).catch(() => false)) === false)
    return { ok: false, error: `${path.basename(file)} couldn't be played as a sound` }
  return { ok: true, file }
}
