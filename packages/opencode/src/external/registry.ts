export * as ExternalRegistry from "./registry"

import { mkdirSync, watch, type FSWatcher } from "fs"
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
  /** XCOD-265: when it was cleared from /sessions (hidden, restorable). */
  archived?: string
  /**
   * XCOD-325: the name the user gave it in Lunos (/sessions, the Sessions window). Lunos's own; the
   * tool's session id and files are untouched. None: the automatic "Claude Code · folder".
   */
  title?: string
}

const dir = () => path.join(Global.Path.data, "external")
const file = (id: string) => path.join(dir(), `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)

async function write(entry: Entry) {
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(file(entry.sessionID), JSON.stringify(entry, null, 2))
}

/**
 * Writes the whole entry, as the tool runners do on every turn. XCOD-325: a name the user gave is
 * kept: the runners don't know it, and their next save must not take it away.
 */
export async function save(entry: Entry) {
  const title = "title" in entry ? entry.title : (await get(entry.sessionID))?.title
  await write(title ? { ...entry, title } : entry)
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

/** XCOD-265: hides (time) or restores (undefined) an entry in /sessions. False when there is none. */
export async function setArchived(id: string, time: Date | undefined) {
  const entry = await get(id)
  if (!entry) return false
  const { archived: _, ...rest } = entry
  await save(time ? { ...rest, archived: time.toISOString() } : rest)
  return true
}

/**
 * XCOD-325: names an entry (`title` already cleaned, see Session.cleanTitle) or, with "", un-names
 * it, so it goes back to the automatic title. False when there is none.
 */
export async function rename(id: string, title: string) {
  const entry = await get(id)
  if (!entry) return false
  const { title: _, ...rest } = entry
  await write(title ? { ...rest, title } : rest)
  return true
}

/** XCOD-265: forgets an entry. The tool's own transcript (e.g. under ~/.claude) is left alone. */
export async function remove(id: string) {
  await fs.rm(file(id), { force: true })
}

let watcher: FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

/**
 * XCOD-325: calls `listener` when an entry changes, in this process or another one (a rename, a
 * turn starting or ending), so every Sessions view re-reads at once. Returns the unsubscribe.
 */
export function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!watcher) {
    try {
      mkdirSync(dir(), { recursive: true })
      watcher = watch(dir(), () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          for (const each of listeners) each()
        }, 100)
        timer.unref?.()
      })
      watcher.on("error", () => {
        watcher?.close()
        watcher = undefined
      })
      watcher.unref()
    } catch {
      watcher = undefined
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    watcher?.close()
    watcher = undefined
    if (timer) clearTimeout(timer)
    timer = undefined
  }
}
