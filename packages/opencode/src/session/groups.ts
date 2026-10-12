export * as SessionGroups from "./groups"

import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

/**
 * XCOD-205: the user's session groups (by project, client or task), shared by the TUI, the desktop
 * app and `lunos serve` on this machine. One JSON file under the data directory, never sent
 * anywhere. Each call re-reads the file, so a change made by another Lunos process is seen at once.
 *
 * Deleting a group only forgets the group: its sessions go back to "Ungrouped". Assignments are
 * keyed by session id and never pruned here, because one data directory can serve several Lunos
 * databases (one per release channel); a session this process doesn't know is simply not shown.
 */

export interface Group {
  id: string
  name: string
  color?: string
  collapsed: boolean
  created: number
  updated: number
}

export interface State {
  version: 1
  groups: Group[]
  /** Session id to group id. A session is in at most one group. */
  assignments: Record<string, string>
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`No session group ${id}`)
    this.name = "SessionGroupNotFoundError"
  }
}

export class InvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionGroupInvalidError"
  }
}

export const NAME_MAX = 80
const COLOR = /^#[0-9a-fA-F]{6}$/

export const dir = () => Global.Path.data
export const file = () => path.join(dir(), "session-groups.json")

const empty = (): State => ({ version: 1, groups: [], assignments: {} })

function parse(text: string): State {
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== "object") return empty()
    const groups = Array.isArray(value.groups)
      ? value.groups.filter(
          (item: unknown): item is Group =>
            !!item &&
            typeof item === "object" &&
            typeof (item as Group).id === "string" &&
            typeof (item as Group).name === "string",
        )
      : []
    const assignments: Record<string, string> = {}
    if (value.assignments && typeof value.assignments === "object")
      for (const [session, group] of Object.entries(value.assignments))
        if (typeof group === "string") assignments[session] = group
    return {
      version: 1,
      groups: groups.map((group: Group) => ({
        id: group.id,
        name: group.name,
        ...(typeof group.color === "string" && COLOR.test(group.color) ? { color: group.color } : {}),
        collapsed: group.collapsed === true,
        created: Number(group.created) || 0,
        updated: Number(group.updated) || 0,
      })),
      assignments,
    }
  } catch {
    return empty()
  }
}

export async function read(): Promise<State> {
  const text = await fsp.readFile(file(), "utf8").catch(() => undefined)
  if (text === undefined) return empty()
  const state = parse(text)
  // Assignments to a group that no longer exists (deleted by an older build, or a hand edit) read as Ungrouped.
  const known = new Set(state.groups.map((group) => group.id))
  for (const [session, group] of Object.entries(state.assignments))
    if (!known.has(group)) delete state.assignments[session]
  return state
}

async function write(state: State) {
  await fsp.mkdir(dir(), { recursive: true })
  const next = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  await fsp.writeFile(next, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  await fsp.rename(next, file())
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read-modify-write under a lock file, because the TUI, the desktop sidecar and `lunos serve` are
 * separate processes writing the same file. A lock held by a process that is gone, or for longer
 * than a few seconds, is taken over.
 */
async function update<T>(change: (state: State) => T): Promise<T> {
  await fsp.mkdir(dir(), { recursive: true })
  const lock = `${file()}.lock`
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.writeFile(lock, String(process.pid), { flag: "wx" })
      break
    } catch {
      const holder = Number(await fsp.readFile(lock, "utf8").catch(() => "0"))
      const age = await fsp
        .stat(lock)
        .then((stat) => Date.now() - stat.mtimeMs)
        .catch(() => 0)
      // An empty lock is one being written right now, not an abandoned one.
      if ((holder && !alive(holder)) || age > 5_000 || attempt > 250) await fsp.rm(lock, { force: true })
      else await sleep(20)
    }
  }
  try {
    const state = await read()
    const result = change(state)
    await write(state)
    notify()
    return result
  } finally {
    await fsp.rm(lock, { force: true })
  }
}

function cleanName(name: string) {
  const value = name.trim()
  if (!value) throw new InvalidError("A group needs a name")
  if (value.length > NAME_MAX) throw new InvalidError(`A group name can be at most ${NAME_MAX} characters`)
  return value
}

function cleanColor(color: string | null | undefined) {
  if (color === null || color === undefined || color === "") return undefined
  if (!COLOR.test(color)) throw new InvalidError("A group colour is a hex colour like #3b82f6")
  return color.toLowerCase()
}

function find(state: State, id: string) {
  const group = state.groups.find((item) => item.id === id)
  if (!group) throw new NotFoundError(id)
  return group
}

export async function create(input: { name: string; color?: string | null }) {
  const name = cleanName(input.name)
  const color = cleanColor(input.color)
  return update((state) => {
    const now = Date.now()
    const group: Group = {
      id: `grp_${crypto.randomBytes(8).toString("hex")}`,
      name,
      ...(color ? { color } : {}),
      collapsed: false,
      created: now,
      updated: now,
    }
    state.groups.push(group)
    return group
  })
}

/** Rename, recolour (null clears the colour) or collapse/expand a group. */
export async function patch(id: string, input: { name?: string; color?: string | null; collapsed?: boolean }) {
  const name = input.name === undefined ? undefined : cleanName(input.name)
  const color = input.color === undefined ? undefined : cleanColor(input.color)
  return update((state) => {
    const group = find(state, id)
    if (name !== undefined) group.name = name
    if (input.color !== undefined) {
      if (color) group.color = color
      else delete group.color
    }
    if (input.collapsed !== undefined) group.collapsed = input.collapsed
    group.updated = Date.now()
    return { ...group }
  })
}

/** Forgets the group. Its sessions are untouched and show as Ungrouped. */
export async function remove(id: string) {
  return update((state) => {
    find(state, id)
    state.groups = state.groups.filter((group) => group.id !== id)
    for (const [session, group] of Object.entries(state.assignments))
      if (group === id) delete state.assignments[session]
    return true
  })
}

/** Puts sessions in a group (moving them out of any other), or back to Ungrouped with null. */
export async function move(sessionIDs: string[], groupID: string | null) {
  if (sessionIDs.length === 0) throw new InvalidError("Nothing to move")
  return update((state) => {
    if (groupID !== null) find(state, groupID)
    for (const session of sessionIDs) {
      if (groupID === null) delete state.assignments[session]
      else state.assignments[session] = groupID
    }
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// Change notification: in this process after every write, and from other processes via a watch.

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  for (const listener of listeners) listener()
}

let watcher: fs.FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Calls `listener` when the groups change, in this process or another one. The directory is
 * watched rather than the file: the file is replaced by a rename, which ends a watch on the file
 * itself on Linux. Returns the unsubscribe function.
 */
export function subscribe(listener: Listener) {
  listeners.add(listener)
  if (!watcher) {
    try {
      fs.mkdirSync(dir(), { recursive: true })
      watcher = fs.watch(dir(), (_event, name) => {
        if (name && String(name) !== path.basename(file())) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(notify, 100)
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
