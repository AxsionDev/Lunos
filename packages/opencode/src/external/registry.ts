export * as ExternalRegistry from "./registry"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { ExternalDetect } from "./detect"

/**
 * XCOD-204: the external sessions Lunos started, so `lunos external sessions` can list them,
 * `resume` can find them and `stop` can end a running one. Kept on this machine only. The
 * transcript is the tool's own (Claude Code keeps it under ~/.claude); Lunos stores the session
 * id, tool, directory, timestamps, cost and outcome, never the prompt or the output.
 */

export interface Entry {
  sessionID: string
  tool: ExternalDetect.Tool
  cwd: string
  started: string
  updated: string
  status: "running" | "done" | "failed" | "stopped"
  pid?: number
  costUSD?: number
  turns?: number
}

const dir = () => path.join(Global.Path.data, "external")
const file = (id: string) => path.join(dir(), `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)

export async function save(entry: Entry) {
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(file(entry.sessionID), JSON.stringify(entry, null, 2))
}

export async function get(id: string) {
  return fs
    .readFile(file(id), "utf8")
    .then((text) => JSON.parse(text) as Entry)
    .catch(() => undefined)
}

function alive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Newest first. A "running" session whose process is gone is shown as stopped. */
export async function list() {
  const names = await fs.readdir(dir()).catch(() => [] as string[])
  const entries = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => get(name.slice(0, -5))),
  )
  return entries
    .filter((entry): entry is Entry => !!entry)
    .map((entry) =>
      entry.status === "running" && !alive(entry.pid) ? { ...entry, status: "stopped" as const } : entry,
    )
    .toSorted((a, b) => b.updated.localeCompare(a.updated))
}

/** Ends a running session's process (SIGINT, so the tool ends its turn cleanly). */
export async function stop(id: string) {
  const entry = await get(id)
  if (!entry) return { ok: false as const, reason: `No external session ${id}` }
  if (entry.status !== "running" || !alive(entry.pid)) return { ok: false as const, reason: `${id} isn't running` }
  process.kill(entry.pid!, "SIGINT")
  await save({ ...entry, status: "stopped", updated: new Date().toISOString() })
  return { ok: true as const }
}
