export * as SecurityTarget from "./target"

import path from "path"
import { Process } from "@/util/process"

/**
 * What `/security-review` and `lunos security-review` look at (XCOD-334):
 *
 * - `uncommitted` (default): staged, unstaged and untracked changes against HEAD.
 * - `branch`: everything on `<name>` since it left `base` (its merge base with the default branch,
 *   or `--base`).
 * - `pr`: a pull request through `gh`, against its base branch.
 *
 * `base` is the ref the project's own rules (`.lunos/security.md`) are read from: a change can't
 * weaken the rules it is reviewed under.
 */
export type Spec =
  | { kind: "uncommitted" }
  | { kind: "branch"; name: string; base?: string }
  | { kind: "pr"; number: string }

export type Line = { line: number; text: string }

export type Change = {
  /** Repository-relative, forward slashes. */
  file: string
  added: Line[]
  deleted: boolean
  /**
   * XCOD-334: lines of the new file next to which lines were removed. Removing `[ValidateAntiForgeryToken]`
   * adds nothing, but it is the change that matters: file rules treat these lines as touched.
   */
  removed?: number[]
}

export type Resolved = {
  label: string
  changes: Change[]
  /** The file at the reviewed revision (the working tree for uncommitted changes). */
  after: (file: string) => Promise<string | undefined>
  /** The file at the base revision. */
  before: (file: string) => Promise<string | undefined>
  /** The project's security rules, read from the base. */
  rules: () => Promise<string | undefined>
}

export const RULES_FILE = ".lunos/security.md"
// Git's well-known empty tree: the base of a repository with no commits yet.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const MAX_FILE_BYTES = 1024 * 1024

/** `--branch <name>`, `--base <ref>`, `--pr <number>` as typed after `/security-review`. */
export function parse(input: string): Spec {
  const words = input.trim().split(/\s+/).filter(Boolean)
  const value = (flag: string) => {
    const index = words.indexOf(flag)
    if (index >= 0) return words[index + 1]
    return words.find((word) => word.startsWith(flag + "="))?.slice(flag.length + 1)
  }
  const pr = value("--pr")
  if (pr) return { kind: "pr", number: pr.replace(/^#/, "").replace(/.*\/pull\/(\d+).*/, "$1") }
  const name = value("--branch")
  if (name) return { kind: "branch", name, base: value("--base") }
  return { kind: "uncommitted" }
}

export function label(spec: Spec) {
  if (spec.kind === "pr") return `pr ${spec.number}`
  if (spec.kind === "branch") return `branch ${spec.name}`
  return "uncommitted"
}

export async function resolve(cwd: string, spec: Spec): Promise<Resolved> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim()
  if (!root) throw new Error(`${cwd} is not inside a git repository`)
  if (spec.kind === "pr") return resolvePr(root, spec.number)
  if (spec.kind === "branch") {
    const into = spec.base ?? (await defaultBranch(root))
    const base = (await git(root, ["merge-base", into, spec.name])).trim()
    if (!base) throw new Error(`no merge base between ${into} and ${spec.name}`)
    return {
      label: label(spec),
      changes: parseDiff(await git(root, ["diff", "--no-color", "--no-ext-diff", "--unified=0", base, spec.name])),
      after: (file) => show(root, spec.name, file),
      before: (file) => show(root, base, file),
      rules: () => show(root, base, RULES_FILE),
    }
  }
  const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim()
  const base = head || EMPTY_TREE
  const tracked = parseDiff(await git(root, ["diff", "--no-color", "--no-ext-diff", "--unified=0", base]))
  // `git diff` never shows untracked files: they are new, so every line is added.
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
  const added = await Promise.all(
    untracked.map(async (file) => {
      const text = await readDisk(root, file)
      return { file, added: text === undefined ? [] : lines(text), deleted: false }
    }),
  )
  return {
    label: label(spec),
    changes: [...tracked, ...added],
    after: (file) => readDisk(root, file),
    before: (file) => (head ? show(root, head, file) : Promise.resolve(undefined)),
    rules: () => (head ? show(root, head, RULES_FILE) : Promise.resolve(undefined)),
  }
}

async function resolvePr(root: string, number: string): Promise<Resolved> {
  const view = await Process.text(["gh", "pr", "view", number, "--json", "baseRefOid,headRefOid,baseRefName"], {
    cwd: root,
    nothrow: true,
  })
  if (view.code !== 0)
    throw new Error(`gh pr view ${number} failed: ${view.stderr.toString().trim() || "is gh installed and signed in?"}`)
  const info = JSON.parse(view.text) as { baseRefOid: string; headRefOid: string }
  const diff = await Process.text(["gh", "pr", "diff", number], { cwd: root, nothrow: true })
  if (diff.code !== 0) throw new Error(`gh pr diff ${number} failed: ${diff.stderr.toString().trim()}`)
  const content = (ref: string) => async (file: string) => {
    const local = await show(root, ref, file)
    if (local !== undefined) return local
    // The commit isn't fetched locally: ask the git host.
    const out = await Process.text(
      ["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/{owner}/{repo}/contents/${file}?ref=${ref}`],
      { cwd: root, nothrow: true },
    )
    return out.code === 0 ? out.text : undefined
  }
  return {
    label: `pr ${number}`,
    changes: parseDiff(diff.text),
    after: content(info.headRefOid),
    before: content(info.baseRefOid),
    rules: () => content(info.baseRefOid)(RULES_FILE),
  }
}

/** Unified diff to the added lines of each file, numbered as in the new file. */
export function parseDiff(diff: string): Change[] {
  const changes: Change[] = []
  let current: Change | undefined
  let old = ""
  let next = 0
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = undefined
      continue
    }
    if (!current && raw.startsWith("--- ")) {
      old = unquote(raw.slice(4).trim()).replace(/^a\//, "")
      continue
    }
    if (!current && raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim()
      current =
        target === "/dev/null"
          ? { file: old, added: [], deleted: true }
          : { file: unquote(target).replace(/^b\//, ""), added: [], deleted: false }
      changes.push(current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (hunk) {
      // "+N,0": nothing added, and the removed lines sat after line N of the new file.
      next = hunk[2] === "0" ? Number(hunk[1]) + 1 : Number(hunk[1])
      continue
    }
    if (!current) continue
    if (raw.startsWith("-")) {
      // Between new-file lines next - 1 and next. A file deleted outright has no new-file lines.
      if (current.deleted) continue
      const removed = (current.removed ??= [])
      for (const line of [next - 1, next]) if (line > 0 && !removed.includes(line)) removed.push(line)
      continue
    }
    if (raw.startsWith("+")) {
      current.added.push({ line: next, text: raw.slice(1) })
      next++
      continue
    }
    if (raw.startsWith(" ")) next++
  }
  return changes.filter((change) => change.added.length || change.deleted || change.removed?.length)
}

function unquote(value: string) {
  if (!value.startsWith('"')) return value
  return JSON.parse(value) as string
}

function lines(text: string): Line[] {
  return text.split("\n").map((line, index) => ({ line: index + 1, text: line }))
}

async function git(cwd: string, args: string[]) {
  const out = await Process.text(["git", ...args], { cwd, nothrow: true })
  return out.code === 0 ? out.text : ""
}

async function show(root: string, ref: string, file: string) {
  const out = await Process.text(["git", "show", `${ref}:${file}`], { cwd: root, nothrow: true })
  return out.code === 0 ? out.text : undefined
}

async function readDisk(root: string, file: string) {
  const handle = Bun.file(path.join(root, file))
  if (!(await handle.exists()) || handle.size > MAX_FILE_BYTES) return undefined
  const text = await handle.text()
  // Binary files have no lines worth scanning.
  if (text.includes("\0")) return undefined
  return text
}

/** The remote's default branch, else the first of dev, main, master that exists. */
async function defaultBranch(root: string) {
  const remote = (await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim()
  if (remote) return remote
  for (const name of ["dev", "main", "master"])
    if ((await git(root, ["rev-parse", "--verify", "--quiet", name])).trim()) return name
  throw new Error("could not find the default branch: pass --base <ref>")
}
