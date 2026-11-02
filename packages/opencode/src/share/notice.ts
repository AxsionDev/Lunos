export * as ShareNotice from "./notice"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

/**
 * XCOD-266: with `share: "auto"` and nowhere to upload to, every new session would refuse to share.
 * The "Sharing needs a Lunos organisation" line is shown once per project instead, and which
 * projects were told is kept in Lunos's state directory, so a restart doesn't repeat it. A typed
 * `/share` or `--share` always answers.
 *
 * Keys carry the surface that showed the line ("tui", "cli"): `lunos run` creates its session before
 * it listens to events, so a notice the server sent then is never seen, and mustn't count for the CLI.
 */

const file = () => path.join(Global.Path.state, "share-notice.json")

/** The key a project is kept under. Directories outside a git repository each get their own. */
export function project(input: { project: { id: string }; directory: string }) {
  return input.project.id === "global" ? `global:${input.directory}` : input.project.id
}

async function read(): Promise<string[]> {
  const text = await fs.readFile(file(), "utf8").catch(() => undefined)
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

// Sessions created together each ask at once: one at a time, or they all read "not shown yet".
let last: Promise<unknown> = Promise.resolve()

/** True the first time it's asked for this key, and records that; false from then on. */
export function once(key: string): Promise<boolean> {
  const next = last.then(async () => {
    const seen = await read()
    if (seen.includes(key)) return false
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), JSON.stringify([...seen, key], null, 2), { mode: 0o600 })
    return true
  })
  last = next.catch(() => undefined)
  return next
}
