import path from "path"
import os from "os"
import fs from "fs/promises"
import { realpathSync } from "fs"

/**
 * XCOD-332: each writing subagent of a Dynamic workflow edits its own git worktree, on a branch
 * `lunos/<session>/<step>` made from the orchestrator's HEAD plus its uncommitted changes (a
 * snapshot commit built with a temporary index, so the user's index, stashes and branches are never
 * touched). When the subagent finishes, its branch is merged into the user's working tree with
 * `git merge-tree` and applied with `git apply`, which changes the working tree only. Lockfiles are
 * regenerated, `package.json` is merged key by key and purely additive conflicts are combined;
 * anything else is a conflict the caller hands to the `merge` subagent and then to the user.
 *
 * Plain async git, so the engine is testable on real repositories; the task tool wires it in.
 */

export type Mode = "worktree" | "shared"
export type Decision = { mode: Mode; reason: string }

/** A subagent's isolated copy. `root` is the user's git top level; `directory` the worktree. */
export type Handle = {
  root: string
  directory: string
  branch: string
  /** The commit the worktree started from: the snapshot of the user's tree at dispatch. */
  base: string
  /** Paths symlinked from the user's tree (node_modules), never committed. */
  linked: string[]
}

export type Stat = { files: string[]; additions: number; deletions: number }
export type ConflictFile = { path: string; base: string; ours: string; theirs: string }
export type MergeResult =
  | ({ state: "empty" } & Stat)
  | ({ state: "merged"; regenerated?: string; resolved: string[] } & Stat)
  | ({ state: "conflict"; conflicts: ConflictFile[]; ours: string } & Stat)

export type GitResult = { code: number; stdout: string; stderr: string }

const IDENTITY = ["-c", "user.name=Lunos", "-c", "user.email=lunos@localhost", "-c", "commit.gpgSign=false"]
const BRANCH_PREFIX = "lunos/"
const LOCK_REASON = "lunos pid "
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]

export async function git(args: string[], opts: { cwd: string; env?: Record<string, string>; stdin?: string }) {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr } satisfies GitResult
}

async function must(args: string[], opts: Parameters<typeof git>[1]) {
  const result = await git(args, opts)
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

/**
 * Whether a writing subagent gets a worktree. `shared` (today's behaviour) for a non-git folder,
 * `subagent.isolation: "shared"`, a read-only subagent, the sandbox, an unborn HEAD or an old git.
 */
export async function decide(input: {
  configured?: Mode
  vcs?: string
  writes: boolean
  sandboxed?: boolean
  directory: string
}): Promise<Decision> {
  if (input.configured === "shared") return { mode: "shared", reason: 'subagent.isolation is "shared"' }
  if (input.vcs !== "git") return { mode: "shared", reason: "not a git repository" }
  if (!input.writes) return { mode: "shared", reason: "read-only subagent" }
  if (input.sandboxed)
    return { mode: "shared", reason: "the sandbox can only see your working tree, so subagents share it" }
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: input.directory })
  if (head.code !== 0) return { mode: "shared", reason: "the repository has no commit yet" }
  const version = (await git(["--version"], { cwd: input.directory })).stdout.match(/(\d+)\.(\d+)/)
  if (!version || Number(version[1]) * 1000 + Number(version[2]) < 2038)
    return { mode: "shared", reason: "git 2.38 or later is needed for worktree isolation" }
  return { mode: "worktree", reason: "writing subagent in a git repository" }
}

/** The git top level of `directory`. */
export async function toplevel(directory: string) {
  return (await must(["rev-parse", "--show-toplevel"], { cwd: directory })).trim()
}

/**
 * A commit of HEAD plus every uncommitted change (tracked and untracked, not ignored), made with a
 * temporary index: the user's index, stash and branches stay as they are. Dangling until used.
 */
export async function snapshot(root: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-snap-"))
  const env = { GIT_INDEX_FILE: path.join(dir, "index") }
  try {
    await must(["read-tree", "HEAD"], { cwd: root, env })
    await must(["add", "-A", "--", "."], { cwd: root, env })
    const tree = (await must(["write-tree"], { cwd: root, env })).trim()
    return (
      await must([...IDENTITY, "commit-tree", "--no-gpg-sign", tree, "-p", "HEAD", "-m", "lunos snapshot"], {
        cwd: root,
      })
    ).trim()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// git's worktree bookkeeping (.git/worktrees) isn't safe for concurrent adds and removes in one
// repository, and parallel subagents start and finish together: one at a time per repository.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(root: string, fn: () => Promise<T>) {
  const next = (queues.get(root) ?? Promise.resolve()).catch(() => undefined).then(fn)
  queues.set(root, next)
  return next
}

function slug(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "step"
  )
}

/** Where a project's subagent worktrees live: outside the repository, never in the user's tree. */
export function home(dataDir: string, root: string) {
  return path.join(dataDir, "worktree", "subagents", Bun.hash(root).toString(36))
}

/** A worktree for one subagent step, on `lunos/<session>/<step>`, locked to this process. */
export async function create(input: { root: string; dataDir: string; session: string; step: string }) {
  const started = Date.now()
  const base = await snapshot(input.root)
  const name = `${slug(input.session)}-${slug(input.step)}`
  const branch = `${BRANCH_PREFIX}${slug(input.session)}/${slug(input.step)}`
  const parent = home(input.dataDir, input.root)
  await fs.mkdir(parent, { recursive: true })
  const taken = async (candidate: { directory: string; branch: string }) =>
    (await fs
      .stat(candidate.directory)
      .then(() => true)
      .catch(() => false)) ||
    (await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate.branch}`], { cwd: input.root })).code === 0
  const pick = async (n: number): Promise<{ directory: string; branch: string }> => {
    const candidate = {
      directory: path.join(parent, n ? `${name}-${n}` : name),
      branch: n ? `${branch}-${n}` : branch,
    }
    if (!(await taken(candidate))) return candidate
    return pick(n + 1)
  }
  // Two steps with the same description can race for a name: the loser takes the next one.
  const add = async (n: number, attempts: number): Promise<{ directory: string; branch: string }> => {
    const target = await pick(n)
    const out = await git(
      [
        "worktree",
        "add",
        "--lock",
        "--reason",
        `${LOCK_REASON}${process.pid}`,
        "-b",
        target.branch,
        target.directory,
        base,
      ],
      { cwd: input.root },
    )
    if (out.code === 0) return target
    if (attempts <= 0 || !/already exists/.test(out.stderr))
      throw new Error(`git worktree add failed: ${out.stderr.trim()}`)
    return add(n + 1, attempts - 1)
  }
  const target = await serial(input.root, () => add(0, 5))
  const linked = await link(input.root, target.directory)
  await include(input.root, target.directory)
  return { handle: { root: input.root, ...target, base, linked } satisfies Handle, ms: Date.now() - started }
}

/**
 * A fresh worktree has no node_modules, so a builder couldn't run tests. Symlink the user's
 * (top level and next to every tracked package.json); they're excluded from the subagent's commit.
 */
async function link(root: string, directory: string) {
  const manifests = (await git(["ls-files", "--", "package.json", "*/package.json"], { cwd: root })).stdout
    .split("\n")
    .filter((line) => line && !line.includes("node_modules/"))
  const dirs = [...new Set(["", ...manifests.map((item) => path.dirname(item)).filter((item) => item !== ".")])]
  const found = await Promise.all(
    dirs.map(async (dir) => {
      const rel = path.join(dir, "node_modules")
      const source = path.join(root, rel)
      const stat = await fs.lstat(source).catch(() => undefined)
      if (!stat?.isDirectory()) return undefined
      const target = path.join(directory, rel)
      if (await fs.lstat(target).catch(() => undefined)) return undefined
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.symlink(source, target, "dir")
      return rel
    }),
  )
  return found.filter((item): item is string => !!item)
}

/** `.worktreeinclude`: gitignored files (.env and the like) copied into each worktree. */
async function include(root: string, directory: string) {
  const list = await Bun.file(path.join(root, ".worktreeinclude"))
    .text()
    .catch(() => "")
  const entries = list
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !path.isAbsolute(line) && !line.split(/[\\/]/).includes(".."))
  await Promise.all(
    entries.map(async (entry) => {
      const source = path.join(root, entry)
      if (!(await Bun.file(source).exists())) return
      await fs.mkdir(path.dirname(path.join(directory, entry)), { recursive: true })
      await fs.copyFile(source, path.join(directory, entry))
    }),
  )
}

/** Commits whatever the subagent changed in its worktree. Undefined when it changed nothing. */
export async function finalize(handle: Handle, message = "lunos subagent") {
  const excludes = handle.linked.map((item) => `:(exclude)${item}`)
  await must(["add", "-A", "--", ".", ...excludes], { cwd: handle.directory })
  const staged = await git(["diff", "--cached", "--quiet"], { cwd: handle.directory })
  if (staged.code === 0) return undefined
  await must([...IDENTITY, "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", message], { cwd: handle.directory })
  return (await must(["rev-parse", "HEAD"], { cwd: handle.directory })).trim()
}

/** What the subagent changed against where it started: the sidebar's diff size. */
export async function stat(handle: Handle): Promise<Stat> {
  const out = await must(["diff", "--numstat", handle.base, handle.branch], { cwd: handle.root })
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
  return {
    files: rows.map((row) => row[2] ?? ""),
    additions: rows.reduce((sum, row) => sum + (Number(row[0]) || 0), 0),
    deletions: rows.reduce((sum, row) => sum + (Number(row[1]) || 0), 0),
  }
}

/** The subagent's changes as a patch (`/subagents diff`, or saved when nothing could be merged). */
export async function diff(handle: Handle) {
  return must(["diff", "--binary", handle.base, handle.branch], { cwd: handle.root })
}

/**
 * Merges the subagent's branch into the user's working tree (never their index or branch).
 * `regenerate` runs when a package manifest changed or a lockfile conflicted. Nothing is written
 * unless every conflict could be resolved.
 */
export async function merge(
  handle: Handle,
  opts: { regenerate?: (root: string) => Promise<string | undefined> } = {},
): Promise<MergeResult> {
  const changes = await stat(handle)
  if (!changes.files.length) return { state: "empty", ...changes }
  const ours = await snapshot(handle.root)
  const result = await git(
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${handle.base}`, ours, handle.branch],
    { cwd: handle.root },
  )
  if (result.code > 1) throw new Error(`git merge-tree failed: ${result.stderr.trim()}`)
  const lines = result.stdout.split("\n")
  const tree = lines[0]!.trim()
  const conflicted = [
    ...new Set(
      lines
        .slice(1)
        .filter(Boolean)
        .map((line) => line.trim()),
    ),
  ]
  const show = (rev: string, file: string) =>
    git(["show", `${rev}:${file}`], { cwd: handle.root }).then((out) => (out.code === 0 ? out.stdout : ""))
  const attempts = await Promise.all(
    conflicted.map(async (file) => {
      const versions = {
        path: file,
        base: await show(handle.base, file),
        ours: await show(ours, file),
        theirs: await show(handle.branch, file),
      }
      return { versions, resolved: await trivial(handle.root, versions) }
    }),
  )
  const open = attempts.filter((item) => item.resolved === undefined).map((item) => item.versions)
  if (open.length) return { state: "conflict", conflicts: open, ours, ...changes }

  const excludes = conflicted.map((file) => `:(exclude,literal)${file}`)
  const patch = await must(["diff", "--binary", "--full-index", ours, tree, "--", ".", ...excludes], {
    cwd: handle.root,
  })
  if (patch.trim()) await must(["apply", "--binary", "--whitespace=nowarn", "-"], { cwd: handle.root, stdin: patch })
  await Promise.all(
    attempts.map(async (item) => {
      const target = path.join(handle.root, item.versions.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await Bun.write(target, item.resolved!)
    }),
  )

  const touched = (await must(["diff", "--name-only", ours, tree], { cwd: handle.root })).split("\n").filter(Boolean)
  const manifests = [...touched, ...conflicted].some((file) => path.basename(file) === "package.json")
  const lockConflict = conflicted.some((file) => LOCKFILES.includes(path.basename(file)))
  const regenerated = (manifests || lockConflict) && opts.regenerate ? await opts.regenerate(handle.root) : undefined
  return { state: "merged", resolved: conflicted, ...changes, ...(regenerated ? { regenerated } : {}) }
}

/**
 * The conflicts resolved without a model: a lockfile (keep ours; it's regenerated), `package.json`
 * merged key by key, and a file both sides only added lines to (both additions kept).
 */
async function trivial(root: string, file: ConflictFile) {
  const name = path.basename(file.path)
  if (LOCKFILES.includes(name)) return file.ours
  if (name === "package.json") return mergeJson(file)
  if (!additive(file.base, file.ours) || !additive(file.base, file.theirs)) return undefined
  return union(root, file)
}

/** Whether `next` only adds lines to `base`: every line of `base` is still there, in order. */
function additive(base: string, next: string) {
  const lines = next.split("\n")
  let cursor = 0
  for (const line of base.split("\n")) {
    const found = lines.indexOf(line, cursor)
    if (found < 0) return false
    cursor = found + 1
  }
  return true
}

async function union(root: string, file: ConflictFile) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-merge-"))
  try {
    const paths = { ours: path.join(dir, "ours"), base: path.join(dir, "base"), theirs: path.join(dir, "theirs") }
    await Promise.all([
      Bun.write(paths.ours, file.ours),
      Bun.write(paths.base, file.base),
      Bun.write(paths.theirs, file.theirs),
    ])
    const out = await git(["merge-file", "-p", "--union", paths.ours, paths.base, paths.theirs], { cwd: root })
    return out.stdout
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * A 3-way merge of a JSON document, key by key: both sides adding dependencies to the same object
 * (each changing the last line's comma) merges; the same key changed two ways doesn't. Keeps the
 * file's indentation and trailing newline.
 */
export function mergeJson(file: Pick<ConflictFile, "base" | "ours" | "theirs">) {
  const parse = (text: string) => {
    if (!text.trim()) return {}
    try {
      return JSON.parse(text) as Json
    } catch {
      return undefined
    }
  }
  const base = parse(file.base)
  const ours = parse(file.ours)
  const theirs = parse(file.theirs)
  if (base === undefined || ours === undefined || theirs === undefined) return undefined
  const merged = mergeValue(base, ours, theirs)
  if (merged === CONFLICT) return undefined
  const indent = file.ours.match(/^[ \t]+(?=")/m)?.[0] ?? "  "
  return JSON.stringify(merged, null, indent) + (file.ours.endsWith("\n") ? "\n" : "")
}

const CONFLICT = Symbol("conflict")
const MISSING = Symbol("missing")
type Slot = Json | typeof MISSING

function isObject(value: Slot): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeValue(base: Slot, ours: Slot, theirs: Slot): Slot | typeof CONFLICT {
  const same = (a: Slot, b: Slot) => JSON.stringify(a) === JSON.stringify(b)
  if (same(ours, theirs)) return ours
  if (same(base, ours)) return theirs
  if (same(base, theirs)) return ours
  if (!isObject(ours) || !isObject(theirs)) return CONFLICT
  const from = isObject(base) ? base : {}
  // Our key order first, then keys only they added, in their order.
  const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]
  const out: { [key: string]: Json } = {}
  for (const key of keys) {
    const value = mergeValue(
      key in from ? from[key]! : MISSING,
      key in ours ? ours[key]! : MISSING,
      key in theirs ? theirs[key]! : MISSING,
    )
    if (value === CONFLICT) return CONFLICT
    if (value !== MISSING) out[key] = value
  }
  return out
}

/**
 * Brings the user's current tree into the subagent's branch, leaving conflict markers in its
 * worktree for the `merge` subagent. After it resolves them, `conclude` commits, and the next
 * `merge` applies cleanly (its base becomes the snapshot it merged).
 */
export async function prepareConflict(handle: Handle, ours: string) {
  const result = await git([...IDENTITY, "merge", "--no-ff", "--no-commit", "--no-verify", ours], {
    cwd: handle.directory,
  })
  const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"], { cwd: handle.directory })).stdout
    .split("\n")
    .filter(Boolean)
  return { clean: result.code === 0, unmerged }
}

/** After the `merge` subagent: true, with the merge committed, when no conflict marker is left. */
export async function conclude(handle: Handle, ours: string) {
  const excludes = handle.linked.map((item) => `:(exclude)${item}`)
  await must(["add", "-A", "--", ".", ...excludes], { cwd: handle.directory })
  const files = (await git(["diff", "--cached", "--name-only"], { cwd: handle.directory })).stdout
    .split("\n")
    .filter(Boolean)
  const markers = await Promise.all(
    files.map(async (file) => {
      const text = await Bun.file(path.join(handle.directory, file))
        .text()
        .catch(() => "")
      return /^(<{7}|>{7})( |$)/m.test(text)
    }),
  )
  if (markers.some(Boolean)) return false
  const unmerged = (await git(["ls-files", "-u"], { cwd: handle.directory })).stdout.trim()
  if (unmerged) return false
  await must([...IDENTITY, "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", "lunos merge"], {
    cwd: handle.directory,
  })
  handle.base = ours
  return true
}

/** Abandons a conflicted merge in the worktree (its branch keeps the subagent's own commit). */
export async function abortConflict(handle: Handle) {
  await git(["merge", "--abort"], { cwd: handle.directory })
}

/**
 * Applies the user's choice for the conflicted files on top of an otherwise clean merge: "theirs"
 * takes the subagent's version of each, "ours" keeps the user's.
 */
export async function settle(
  handle: Handle,
  choice: "ours" | "theirs",
  opts: { regenerate?: (root: string) => Promise<string | undefined> } = {},
) {
  const first = await merge(handle, opts)
  if (first.state !== "conflict") return first
  const ours = first.ours
  // Rebuild the subagent's branch with the conflicted files decided, then merge again cleanly.
  await prepareConflict(handle, ours)
  await Promise.all(
    first.conflicts.map(async (file) => {
      const target = path.join(handle.directory, file.path)
      const content = choice === "theirs" ? file.theirs : file.ours
      await fs.mkdir(path.dirname(target), { recursive: true })
      await Bun.write(target, content)
    }),
  )
  const done = await conclude(handle, ours)
  if (!done) throw new Error("could not settle the conflict")
  return merge(handle, opts)
}

/** Removes a subagent's worktree and branch. Never anything but `lunos/*`. */
export async function discard(handle: Pick<Handle, "root" | "directory" | "branch">) {
  if (!handle.branch.startsWith(BRANCH_PREFIX)) throw new Error(`refusing to remove ${handle.branch}`)
  return serial(handle.root, () => remove(handle))
}

async function remove(handle: Pick<Handle, "root" | "directory" | "branch">) {
  await git(["worktree", "unlock", handle.directory], { cwd: handle.root })
  await git(["worktree", "remove", "--force", "--force", handle.directory], { cwd: handle.root })
  await fs.rm(handle.directory, { recursive: true, force: true })
  await git(["worktree", "prune"], { cwd: handle.root })
  await git(["branch", "-D", handle.branch], { cwd: handle.root })
}

function alive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Removes subagent worktrees and `lunos/*` branches left behind: by a crashed process (its pid is
 * gone) and, with `own`, this process's (on exit). A live Lunos's running worktrees are kept.
 */
export async function sweep(input: { root: string; dataDir: string; own?: boolean }) {
  const parent = home(input.dataDir, input.root)
  const list = await git(["worktree", "list", "--porcelain"], { cwd: input.root })
  if (list.code !== 0) return []
  const entries = list.stdout
    .split("\n\n")
    .map((block) => ({
      directory: block.match(/^worktree (.+)$/m)?.[1]?.trim() ?? "",
      branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim() ?? "",
      locked: block.match(/^locked ?(.*)$/m)?.[1]?.trim(),
    }))
    .filter((entry) => entry.branch.startsWith(BRANCH_PREFIX) && within(parent, entry.directory))
  const owner = (entry: (typeof entries)[number]) =>
    entry.locked?.startsWith(LOCK_REASON) ? Number(entry.locked.slice(LOCK_REASON.length)) : undefined
  const stale = entries.filter((entry) => {
    const pid = owner(entry)
    if (pid === process.pid) return !!input.own
    return pid === undefined || !alive(pid)
  })
  await Promise.all(stale.map((entry) => discard({ root: input.root, ...entry })))
  // Branches whose worktree is already gone (removed by hand, or a crash mid-cleanup).
  const kept = new Set(entries.filter((entry) => !stale.includes(entry)).map((entry) => entry.branch))
  const orphans = (
    await git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`], { cwd: input.root })
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((branch) => branch.startsWith(BRANCH_PREFIX) && !kept.has(branch))
  await Promise.all(orphans.map((branch) => git(["branch", "-D", branch], { cwd: input.root })))
  await git(["worktree", "prune"], { cwd: input.root })
  return [...stale.map((entry) => entry.branch), ...orphans.filter((item) => !stale.some((s) => s.branch === item))]
}

function within(parent: string, child: string) {
  const rel = path.relative(real(parent), real(child))
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
}

// macOS tmp dirs are symlinks (/var -> /private/var); git reports the resolved path.
function real(input: string) {
  try {
    return realpathSync(input)
  } catch {
    return input
  }
}

/**
 * The command that regenerates the lockfile in `root`, by the lockfile present. Lockfile only
 * where the package manager supports it, and never lifecycle scripts.
 */
export async function lockfileCommand(root: string) {
  const has = (name: string) => Bun.file(path.join(root, name)).exists()
  if ((await has("bun.lock")) || (await has("bun.lockb")))
    return ["bun", "install", "--lockfile-only", "--ignore-scripts"]
  if (await has("pnpm-lock.yaml")) return ["pnpm", "install", "--lockfile-only", "--ignore-scripts"]
  if (await has("yarn.lock")) return ["yarn", "install", "--mode=update-lockfile"]
  if ((await has("package-lock.json")) || (await has("npm-shrinkwrap.json")))
    return ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]
  return undefined
}

/** Regenerates the lockfile; returns the command run, or undefined when there's no lockfile. */
export async function regenerate(root: string) {
  const command = await lockfileCommand(root)
  if (!command) return undefined
  const proc = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} failed: ${stderr.trim().slice(0, 500)}`)
  return command.join(" ")
}

/**
 * A path the model gave for the user's tree, mapped into the worktree. The orchestrator's prompt
 * and the system prompt name the user's absolute paths; edits must still land in the worktree.
 */
export function remap(value: string, from: string, to: string) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return value.replace(new RegExp(`${escaped}(?=$|[\\\\/\\s"'\`;:)])`, "g"), to)
}

/** A session bound to a worktree: its file and shell tools run there. */
export type Binding = {
  handle: Handle
  /** The user's git top level and instance directory, and their counterparts in the worktree. */
  from: { root: string; directory: string }
  to: { root: string; directory: string }
}

const bound = new Map<string, Binding>()

/** Binds a session (the subagent's, or the `merge` subagent's) to a worktree. */
export function bind(sessionID: string, binding: Binding) {
  bound.set(sessionID, binding)
  hookExit()
}

export function unbind(sessionID: string) {
  bound.delete(sessionID)
}

/** The session is deleted: its worktree, if any, goes now rather than when its task ends. */
export async function forget(sessionID: string) {
  const binding = bound.get(sessionID)
  bound.delete(sessionID)
  if (!binding) return
  if ([...bound.values()].some((item) => item.handle === binding.handle)) return
  const { disposeInstance } = await import("@/effect/instance-registry")
  await disposeInstance(binding.to.directory).catch(() => undefined)
  await discard(binding.handle).catch(() => undefined)
}

export function lookup(sessionID: string) {
  return bound.get(sessionID)
}

/** The tools that read, write or run in the working tree: the ones the worktree applies to. */
export const TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "glob",
  "grep",
  "list",
  "bash",
  "lsp",
])
const PATH_ONLY = new Set(["read", "write", "edit", "multiedit"])

/**
 * A tool call's arguments with the user's absolute paths moved into the worktree. For read, write
 * and edit only `filePath`: the text being written may mention the path on purpose.
 */
export function remapArgs(tool: string, args: Record<string, unknown>, binding: Binding) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" && (!PATH_ONLY.has(tool) || key === "filePath")
        ? remap(value, binding.from.root, binding.to.root)
        : value,
    ]),
  )
}

let hooked = false
/** On exit, this process's worktrees go too (a crash is swept on the next start). */
function hookExit() {
  if (hooked) return
  hooked = true
  process.once("exit", () => {
    const handles = new Map([...bound.values()].map((item) => [item.handle.directory, item.handle]))
    for (const handle of handles.values()) {
      const run = (args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: handle.root, stdout: "ignore", stderr: "ignore" })
      run(["worktree", "unlock", handle.directory])
      run(["worktree", "remove", "--force", "--force", handle.directory])
      run(["branch", "-D", handle.branch])
    }
  })
}

export * as SubagentIsolation from "./isolation"
