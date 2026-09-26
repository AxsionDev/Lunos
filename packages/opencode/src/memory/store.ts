export * as MemoryStore from "./store"

import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

/**
 * Where memory lives, and the provenance ledger (XCOD-94).
 *
 * - Project memory: `.opencode/memory/graph/` in the worktree. A `.gitignore` of `*` is written
 *   into it, so the graph's database files are never committed; `lunos memory export` is the
 *   reviewable form.
 * - User memory: `memory/user/` in the Lunos data directory.
 * - The embedding model, downloaded once and shared: `memory/models/` in the data directory.
 *
 * Nothing here creates a directory until memory is on and something is remembered or recalled.
 */

export type Scope = "project" | "user"

export const DATASET = "lunos"

/**
 * The project memory belongs to: the git worktree, or the working directory when there is no git
 * repository (the instance reports its worktree as "/" then).
 */
export function projectRoot(ctx: { worktree: string; directory: string }) {
  return ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
}

export function dir(scope: Scope, worktree: string) {
  return scope === "project"
    ? path.join(worktree, ".opencode", "memory", "graph")
    : path.join(Global.Path.data, "memory", "user")
}

/** Where `lunos memory export` writes by default: one `<scope>/<id>.md` per fact. */
export function exportDir(worktree: string) {
  return path.join(worktree, ".opencode", "memory", "export")
}

export function models() {
  return path.join(Global.Path.data, "memory", "models")
}

export function sidecarDir() {
  return path.join(Global.Path.data, "memory", "sidecar")
}

export async function ensure(scope: Scope, worktree: string) {
  const root = dir(scope, worktree)
  await fs.mkdir(root, { recursive: true })
  if (scope === "project") await fs.writeFile(path.join(root, ".gitignore"), "*\n", { flag: "a" }).catch(() => {})
  return root
}

/** Where a fact came from. Every fact carries one; recall shows it next to the fact. */
export interface Provenance {
  sessionID: string
  agent: string
  /** "user message", a worktree-relative file path, or a tool name. */
  source: string
  date: string
}

export interface Fact {
  id: string
  datasetID: string
  text: string
  provenance: Provenance
}

function ledgerFile(root: string) {
  return path.join(root, "facts.jsonl")
}

/**
 * The ledger is Lunos's own record of every fact it stored: the text, the ids the engine gave it
 * and its provenance. `list`, `show` and `export` read only this file, so reviewing memory never
 * needs the engine running.
 */
export async function facts(root: string): Promise<Fact[]> {
  const text = await fs.readFile(ledgerFile(root), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return ""
    throw e
  })
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Fact)
}

export async function add(root: string, fact: Fact) {
  await fs.appendFile(ledgerFile(root), JSON.stringify(fact) + "\n")
}

export async function remove(root: string, id: string) {
  const kept = (await facts(root)).filter((fact) => fact.id !== id)
  const file = ledgerFile(root)
  await fs.writeFile(file + ".tmp", kept.map((fact) => JSON.stringify(fact) + "\n").join(""))
  await fs.rename(file + ".tmp", file)
}
