import fs from "node:fs"
import path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"

// XCOD-279: a sandbox setting saved in /settings takes effect at the restart, and if Lunos can't
// start with it the user mustn't be locked out. Saving one records what it replaced in a journal
// for this process; `/restart` hands the journal to the new process (see cli/restart.ts), which
// puts the old value back if the sandbox then can't start.

export type Change = {
  key: string
  /** The config file it was saved in. */
  file: string
  /** Its JSON path in that file. */
  path: string[]
  /** Whether the file held a value before; when not, undoing removes the key. */
  had: boolean
  previous?: unknown
  value: unknown
}

/** Per process: the TUI's worker saves settings in the same process that restarts. */
export const journalFile = (pid = process.pid, state = Global.Path.state) =>
  path.join(state, `restart-changes-${pid}.json`)

function read(file: string): Change[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
    return Array.isArray(parsed) ? (parsed as Change[]) : []
  } catch {
    return []
  }
}

/** Remember a saved change. Saving the same key again keeps the value from before the first save. */
export function record(change: Change, file = journalFile()) {
  const changes = read(file)
  const index = changes.findIndex((item) => item.key === change.key && item.file === change.file)
  if (index === -1) changes.push(change)
  else changes[index] = { ...changes[index], value: change.value }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(changes), { mode: 0o600 })
}

/** The changes waiting for this restart. The journal is removed, so it can't apply to a later one. */
export function take(file = journalFile()) {
  const changes = read(file)
  fs.rmSync(file, { force: true })
  return changes
}

const at = (doc: unknown, keys: string[]) =>
  keys.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    doc,
  )

/**
 * XCOD-297: whether a change may be undone when the sandbox then can't start. Turning the sandbox
 * off never is: it isn't what made the start fail, and undoing it turned the sandbox back on.
 */
export function undoable(change: Change) {
  if (change.path[0] !== "sandbox") return false
  const value = change.path.length === 1 ? (change.value as { enabled?: unknown } | undefined)?.enabled : change.value
  return !((change.path.length === 1 || ["enabled", "required"].includes(change.path[1]!)) && value === false)
}

/**
 * Put each change back, where the file still holds the value it saved (a later edit by hand wins).
 * Returns the keys undone.
 */
export function revert(changes: readonly Change[]) {
  const undone: string[] = []
  for (const change of changes) {
    let text: string
    try {
      text = fs.readFileSync(change.file, "utf8")
    } catch {
      continue
    }
    if (JSON.stringify(at(parse(text), change.path)) !== JSON.stringify(change.value)) continue
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
    let updated = applyEdits(text, modify(text, change.path, change.had ? change.previous : undefined, options))
    // A removal that leaves `"sandbox": {}` behind takes that with it, as unsetting a setting does.
    for (let depth = change.path.length - 1; !change.had && depth >= 1; depth--) {
      const parent = at(parse(updated), change.path.slice(0, depth))
      if (!parent || typeof parent !== "object" || Object.keys(parent).length > 0) break
      updated = applyEdits(updated, modify(updated, change.path.slice(0, depth), undefined, options))
    }
    fs.writeFileSync(change.file, updated)
    undone.push(change.key)
  }
  return undone
}

export * as SandboxRollback from "./rollback"
