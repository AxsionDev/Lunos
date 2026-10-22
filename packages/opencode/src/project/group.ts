export * as ProjectGroup from "./group"

import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import type { ConfigBudget } from "@opencode-ai/core/config/budget"

/**
 * XCOD-298: named projects. A project is either the repository Lunos already knows
 * (`project/project.ts`, no setup), or a named project the user groups several repositories or
 * directories into ("Axsion web": axsion-web + axsion-api + infra). Named projects are kept on this
 * computer only, in one JSON file under the data directory like the session groups (XCOD-205), and
 * are never sent anywhere. Every call re-reads the file, so a change made by another Lunos process
 * (the TUI, the desktop sidecar, `lunos serve`, the CLI) is seen at once.
 *
 * A session belongs to the project of its working directory (`forSession`), unless it was moved to
 * another one; a subagent's session belongs to its parent's. Moves are keyed by session id and never
 * pruned here, because one data directory can serve several Lunos databases (one per release
 * channel).
 */

export interface Info {
  /** `pgrp_…` for a named project; the repository project's id for an implicit one. */
  id: string
  name: string
  /** Absolute paths. A directory is in the project when it is one of these or inside one. */
  folders: string[]
  archived?: boolean
  /** True for a repository project that isn't in a named project: it has no record here. */
  implicit?: boolean
  time: { created: number; updated: number }
}

/** The repository project a directory is in (`Project.Info`'s fields this needs). */
export interface Repository {
  id: string
  worktree: string
  name?: string
}

/** What `forSession` needs of a session. */
export interface SessionRef {
  id: string
  directory: string
  parentID?: string
  project?: Repository
}

interface State {
  version: 1
  groups: Info[]
  /** Session id to the project id it was moved to (a named project's, or a repository's). */
  sessions: Record<string, string>
  /**
   * XCOD-298: each project's budget, by project id (a named project's or a repository's, which has
   * no record here otherwise). Kept with the projects, on this computer only.
   */
  budgets: Record<string, ConfigBudget.Budget>
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`No project ${id}`)
    this.name = "ProjectGroupNotFoundError"
  }
}

export class InvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProjectGroupInvalidError"
  }
}

export const NAME_MAX = 80
export const PREFIX = "pgrp_"
/** Repository projects without a repository (a plain folder) share the id "global" (`project.ts`). */
const GLOBAL = "global"

export const file = () => path.join(Global.Path.data, "project-groups.json")

const empty = (): State => ({ version: 1, groups: [], sessions: {}, budgets: {} })

const clean = (folder: string) => {
  const value = path.resolve(folder)
  return value.length > 1 && value.endsWith(path.sep) ? value.slice(0, -1) : value
}

/** `directory` is `folder` or inside it: whole path segments only, so `/a/web2` isn't in `/a/web`. */
export function contains(folder: string, directory: string) {
  const root = clean(folder)
  const dir = clean(directory)
  if (dir === root) return true
  return dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

function parse(text: string): State {
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== "object") return empty()
    const groups: Info[] = Array.isArray(value.groups)
      ? value.groups.flatMap((item: Partial<Info> | null): Info[] =>
          item && typeof item.id === "string" && typeof item.name === "string"
            ? [
                {
                  id: item.id,
                  name: item.name,
                  folders: Array.isArray(item.folders)
                    ? item.folders.filter((folder): folder is string => typeof folder === "string")
                    : [],
                  ...(item.archived === true ? { archived: true } : {}),
                  time: {
                    created: Number(item.time?.created) || 0,
                    updated: Number(item.time?.updated) || 0,
                  },
                },
              ]
            : [],
        )
      : []
    const sessions: Record<string, string> = {}
    if (value.sessions && typeof value.sessions === "object")
      for (const [session, project] of Object.entries(value.sessions))
        if (typeof project === "string") sessions[session] = project
    const budgets: Record<string, ConfigBudget.Budget> = {}
    if (value.budgets && typeof value.budgets === "object")
      for (const [project, budget] of Object.entries(value.budgets))
        if (budget && typeof budget === "object" && Number((budget as ConfigBudget.Budget).amount) > 0)
          budgets[project] = budget as ConfigBudget.Budget
    return { version: 1, groups, sessions, budgets }
  } catch {
    return empty()
  }
}

async function read(): Promise<State> {
  const text = await fsp.readFile(file(), "utf8").catch(() => undefined)
  return text === undefined ? empty() : parse(text)
}

/** Read-modify-write under a lock: several Lunos processes on this computer write the file. */
async function update<T>(change: (state: State) => T): Promise<T> {
  return Flock.withLock(`project-groups:${file()}`, async () => {
    const state = await read()
    const result = change(state)
    await fsp.mkdir(path.dirname(file()), { recursive: true })
    const next = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
    await fsp.writeFile(next, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
    await fsp.rename(next, file())
    return result
  })
}

function cleanName(name: string) {
  const value = name.trim()
  if (!value) throw new InvalidError("A project needs a name")
  if (value.length > NAME_MAX) throw new InvalidError(`A project name can be at most ${NAME_MAX} characters`)
  return value
}

function find(state: State, id: string) {
  const group = state.groups.find((item) => item.id === id)
  if (!group) throw new NotFoundError(id)
  return group
}

/** A folder in another named project that's still in use can't be added to a second one. */
function claim(state: State, id: string | undefined, folders: string[]) {
  for (const folder of folders) {
    const owner = state.groups.find(
      (group) => group.id !== id && !group.archived && group.folders.some((item) => clean(item) === folder),
    )
    if (owner) throw new InvalidError(`${folder} is already in the project "${owner.name}"`)
  }
}

const copy = (group: Info): Info => ({ ...group, folders: [...group.folders], time: { ...group.time } })

/** The named projects, archived ones included (they're marked). */
export async function list(): Promise<Info[]> {
  return (await read()).groups.map(copy)
}

/** A named project by id, or by name (case-insensitive) when no id matches. */
export async function get(id: string): Promise<Info | undefined> {
  const groups = (await read()).groups
  const found =
    groups.find((group) => group.id === id) ??
    groups.find((group) => group.name.toLowerCase() === id.trim().toLowerCase() && !group.archived) ??
    groups.find((group) => group.name.toLowerCase() === id.trim().toLowerCase())
  return found ? copy(found) : undefined
}

/** The repository project's implicit group. A plain folder's is the folder itself, not "/". */
export function implicit(directory: string, project: Repository): Info {
  const global = project.id === GLOBAL || project.worktree === "/"
  const folder = global ? clean(directory) : clean(project.worktree)
  return {
    id: global ? `${GLOBAL}:${folder}` : project.id,
    name: (!global && project.name) || path.basename(folder) || folder,
    folders: [folder],
    implicit: true,
    time: { created: 0, updated: 0 },
  }
}

function match(groups: readonly Info[], directory: string) {
  let best: { group: Info; length: number } | undefined
  for (const group of groups) {
    if (group.archived) continue
    for (const folder of group.folders) {
      if (!contains(folder, directory)) continue
      const length = clean(folder).length
      if (!best || length > best.length) best = { group, length }
    }
  }
  return best?.group
}

/** The named projects and moves as they are now, for resolving many directories or sessions at once. */
export interface Snapshot {
  groups: Info[]
  /** Session id to the project id it was moved to. */
  sessions: Record<string, string>
  /** Project id to its budget. */
  budgets: Record<string, ConfigBudget.Budget>
  resolve(directory: string, project?: Repository): Info | undefined
  forSession(session: SessionRef, parent?: (id: string) => SessionRef | undefined): Info | undefined
}

function snapshotOf(state: State): Snapshot {
  const resolveIn = (directory: string, project?: Repository) => {
    const found = match(state.groups, directory)
    if (found) return copy(found)
    return project ? implicit(directory, project) : undefined
  }
  return {
    groups: state.groups.map(copy),
    sessions: { ...state.sessions },
    budgets: structuredClone(state.budgets),
    resolve: resolveIn,
    forSession(session, parent) {
      const seen = new Set<string>()
      let current: SessionRef | undefined = session
      let root = session
      while (current && !seen.has(current.id)) {
        seen.add(current.id)
        root = current
        const moved = state.sessions[current.id]
        if (moved) {
          const group = state.groups.find((item) => item.id === moved)
          if (group) return copy(group)
          // Moved to a repository project: its implicit group, named when it's the session's own.
          if (current.project && implicit(current.directory, current.project).id === moved)
            return implicit(current.directory, current.project)
          return { id: moved, name: moved, folders: [], implicit: true, time: { created: 0, updated: 0 } }
        }
        if (!current.parentID || !parent) break
        current = parent(current.parentID)
      }
      return resolveIn(root.directory, root.project)
    },
  }
}

/** Reads the file once; the result resolves without reading it again. */
export async function snapshot(): Promise<Snapshot> {
  return snapshotOf(await read())
}

/**
 * The project `directory` belongs to: the live named project with the deepest folder that contains
 * it, else the repository project as an implicit group (when `project` is given).
 */
export async function resolve(directory: string, project?: Repository): Promise<Info | undefined> {
  return (await snapshot()).resolve(directory, project)
}

/**
 * The project a session belongs to: the one it was moved to, else its parent's (a subagent counts
 * with the session that started it), else its working directory's. `parent` looks a session up.
 */
export async function forSession(
  session: SessionRef,
  parent?: (id: string) => Promise<SessionRef | undefined>,
): Promise<Info | undefined> {
  const snap = await snapshot()
  if (!parent) return snap.forSession(session)
  // Walk the parents first (they're looked up asynchronously), then resolve against the chain.
  const chain = new Map<string, SessionRef>([[session.id, session]])
  let current: SessionRef | undefined = session
  while (current?.parentID && !chain.has(current.parentID) && !snap.sessions[current.id]) {
    current = await parent(current.parentID)
    if (current) chain.set(current.id, current)
  }
  return snap.forSession(session, (id) => chain.get(id))
}

/** The project ids sessions were moved to, by session id. */
export async function moves(): Promise<Record<string, string>> {
  return { ...(await read()).sessions }
}

export async function create(input: { name: string; folders?: string[] }): Promise<Info> {
  const name = cleanName(input.name)
  const folders = [...new Set((input.folders ?? []).map(clean))]
  return update((state) => {
    if (state.groups.some((group) => !group.archived && group.name.toLowerCase() === name.toLowerCase()))
      throw new InvalidError(`There is already a project named "${name}"`)
    claim(state, undefined, folders)
    const now = Date.now()
    const group: Info = {
      id: `${PREFIX}${crypto.randomBytes(8).toString("hex")}`,
      name,
      folders,
      time: { created: now, updated: now },
    }
    state.groups.push(group)
    return copy(group)
  })
}

export async function rename(id: string, name: string): Promise<Info> {
  const value = cleanName(name)
  return update((state) => {
    const group = find(state, id)
    if (
      state.groups.some((item) => item.id !== id && !item.archived && item.name.toLowerCase() === value.toLowerCase())
    )
      throw new InvalidError(`There is already a project named "${value}"`)
    group.name = value
    group.time.updated = Date.now()
    return copy(group)
  })
}

/** Adds folders (absolute or relative to the working directory). Ones already in it are skipped. */
export async function add(id: string, folders: string[]): Promise<Info> {
  const wanted = [...new Set(folders.map(clean))]
  if (!wanted.length) throw new InvalidError("Name a folder to add")
  return update((state) => {
    const group = find(state, id)
    const fresh = wanted.filter((folder) => !group.folders.some((item) => clean(item) === folder))
    claim(state, id, fresh)
    group.folders.push(...fresh)
    group.time.updated = Date.now()
    return copy(group)
  })
}

export async function remove(id: string, folders: string[]): Promise<Info> {
  const unwanted = new Set(folders.map(clean))
  if (!unwanted.size) throw new InvalidError("Name a folder to remove")
  return update((state) => {
    const group = find(state, id)
    const missing = [...unwanted].filter((folder) => !group.folders.some((item) => clean(item) === folder))
    if (missing.length) throw new InvalidError(`${missing.join(", ")} isn't in the project "${group.name}"`)
    group.folders = group.folders.filter((item) => !unwanted.has(clean(item)))
    group.time.updated = Date.now()
    return copy(group)
  })
}

/**
 * Archives a named project (or brings it back with `archived: false`). An archived project keeps its
 * folders and history, but no directory resolves to it, so new sessions there go to their repository.
 */
export async function archive(id: string, archived = true): Promise<Info> {
  return update((state) => {
    const group = find(state, id)
    if (!archived) {
      if (
        state.groups.some(
          (item) => item.id !== id && !item.archived && item.name.toLowerCase() === group.name.toLowerCase(),
        )
      )
        throw new InvalidError(`There is already a project named "${group.name}"`)
      claim(state, id, group.folders.map(clean))
    }
    if (archived) group.archived = true
    else delete group.archived
    group.time.updated = Date.now()
    return copy(group)
  })
}

/**
 * Moves sessions to a project: a named project's id or a repository project's. `null` undoes the
 * move, so they go back to the project of their working directory.
 */
export async function move(sessionIDs: string[], projectID: string | null) {
  if (sessionIDs.length === 0) throw new InvalidError("Nothing to move")
  return update((state) => {
    if (projectID?.startsWith(PREFIX)) find(state, projectID)
    for (const session of sessionIDs) {
      if (projectID === null) delete state.sessions[session]
      else state.sessions[session] = projectID
    }
    return true
  })
}

const PERIODS = ["monthly", "weekly", "total"]
const ACTIONS = ["warn", "ask", "stop"]

/** XCOD-298: a project's budget (a named project's id or a repository's), or undefined. */
export async function budget(projectID: string): Promise<ConfigBudget.Budget | undefined> {
  const found = (await read()).budgets[projectID]
  return found ? { ...found } : undefined
}

/** Sets a project's budget, or removes it with null. */
export async function setBudget(projectID: string, budget: ConfigBudget.Budget | null) {
  if (budget) {
    if (!(budget.amount > 0)) throw new InvalidError("A budget needs an amount above 0")
    if (budget.period && !PERIODS.includes(budget.period)) throw new InvalidError(`A period is ${PERIODS.join(", ")}`)
    if (
      budget.reset_day !== undefined &&
      !(Number.isInteger(budget.reset_day) && budget.reset_day >= 1 && budget.reset_day <= 28)
    )
      throw new InvalidError("reset_day is a day of the month, 1 to 28")
    if (budget.on_limit && !ACTIONS.includes(budget.on_limit))
      throw new InvalidError(`on_limit is ${ACTIONS.join(", ")}`)
  }
  return update((state) => {
    if (projectID.startsWith(PREFIX)) find(state, projectID)
    if (budget) state.budgets[projectID] = { ...budget }
    else delete state.budgets[projectID]
    return budget ? { ...budget } : null
  })
}
