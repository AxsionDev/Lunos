// Finding and checking the Lunos CLI (XCOD-122). No `vscode` import, so it can be unit-tested.

import * as fs from "fs"
import * as path from "path"

/** Oldest CLI this extension supports: the first release published as `lunos-ai` with a `lunos` binary. */
export const MIN_CLI_VERSION = "1.18.37"

/** The install command from the Lunos README (XCOD-89). npm 12 needs the --allow-scripts flag. */
export const INSTALL_COMMAND = "npm i -g lunos-ai@latest --allow-scripts=lunos-ai"
export const INSTALL_DOCS = "https://github.com/AxsionDev/Lunos#installation"

type Exists = (file: string) => boolean

const isFile: Exists = (file) => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The `lunos` executable: the `lunos.path` setting if set, otherwise the first `lunos` on PATH.
 * Never falls back to `opencode`: that would start upstream opencode under the Lunos name.
 */
export function resolveBinary(input: {
  setting?: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  exists?: Exists
}): string | undefined {
  const exists = input.exists ?? isFile
  const setting = input.setting?.trim()
  if (setting) return exists(setting) ? setting : undefined

  const windows = input.platform === "win32"
  const pathValue = input.env.PATH ?? input.env.Path ?? ""
  const names = windows
    ? (input.env.PATHEXT ?? ".EXE;.CMD;.BAT")
        .split(";")
        .filter(Boolean)
        .map((ext) => `lunos${ext.toLowerCase()}`)
    : ["lunos"]
  for (const dir of pathValue.split(windows ? ";" : ":")) {
    if (!dir) continue
    for (const name of names) {
      const file = path.join(dir, name)
      if (exists(file)) return file
    }
  }
  return undefined
}

/** "1.18.40" from `lunos --version` output; undefined for local builds ("local") or garbage. */
export function parseVersion(output: string) {
  return output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0]
}

export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

/** The warning to show for this CLI version, if any. Local builds (no semver) are trusted. */
export function versionWarning(version: string | undefined) {
  if (!version || compareVersions(version, MIN_CLI_VERSION) >= 0) return undefined
  return `Lunos CLI ${version} is older than ${MIN_CLI_VERSION}, the oldest version this extension supports. Update it with: ${INSTALL_COMMAND}`
}
