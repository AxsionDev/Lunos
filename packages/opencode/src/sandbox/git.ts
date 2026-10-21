import fs from "node:fs/promises"
import { existsSync, lstatSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { SandboxExec } from "./exec"
import { SandboxError } from "./error"

// XCOD-144: the git side of copy mode and of the result handoff. The host repository's working tree,
// index and HEAD are never touched: trees are built with a throwaway index file, and the only write
// to the host repo is the new `lunos/sandbox/<id>` ref (plus the objects it points at).
//
// XCOD-282: a folder that isn't in a repository (or is in one with no commits) gets a private
// "shadow" git directory under Lunos's state, used with `--git-dir <shadow> --work-tree <folder>`.
// Each start commits the folder's contents there as the base, so everything below works unchanged
// with `gitDir` pointing at the shadow. Nothing is written into the folder: the results stay in
// the shadow until `lunos sandbox apply` writes them back. (Upstream's snapshot service keeps a
// similar per-project git dir, but it lives in a project instance, which the sandbox host never
// loads: its git settings are reused here, not the service.)

const git = (args: string[], options?: SandboxExec.Options) => SandboxExec.check(["git", ...args], options)

const ZERO = "0000000000000000000000000000000000000000"
/** Git's messages in English, whatever the machine's language: the detect step reads them. */
const ENGLISH = { LC_ALL: "C", LANGUAGE: "" }

export type Source = "git" | "folder"

export type Repo = {
  /** "folder": not a repository; `gitDir` is Lunos's shadow of it. */
  source: Source
  /** Top of the working tree. */
  root: string
  /** Absolute git dir (for a linked worktree, its own git dir; objects are shared). */
  gitDir: string
  /** The commit the sandbox starts from. */
  base: string
  /** Where the user is, relative to `root` ("" at the top). */
  relative: string
  /** For a folder: what was copied. */
  survey?: Survey
}

/** Where a sandbox for `directory` would start from, found without writing anything. */
export type Location =
  | { source: "git"; root: string; relative: string; base: string }
  | { source: "folder"; root: string; relative: string }

/**
 * Why `git rev-parse --show-toplevel` failed in `directory`, from what git printed. Git refusing a
 * repository it doesn't trust (`safe.directory`, common for a repository on another Windows drive)
 * fails exactly like a folder that isn't a repository, so the stderr decides which one it is.
 */
export function notARepo(directory: string, result: SandboxExec.Result, argv: string[]) {
  const fields = { step: "detect" as const, command: argv, code: result.code, stderr: result.stderr }
  const owned = /detected dubious ownership in repository at '([^']+)'/.exec(result.stderr)
  if (owned)
    return new SandboxError({
      ...fields,
      reason: `Git won't work in ${directory}: the folder belongs to another user, so git doesn't trust it`,
      fix: `If you trust this repository, run \`git config --global --add safe.directory ${owned[1]}\`, then try again.`,
    })
  return new SandboxError({ ...fields, reason: `Git couldn't read the repository at ${directory}` })
}

/**
 * Only git's own "not a git repository" makes a folder a plain one. Anything else (a repository git
 * refuses, a permission error) stays an error: copied as plain files, a real repository would lose
 * its history and take its `.git` along.
 */
export const plainFolder = (result: SandboxExec.Result) => /not a git repository/i.test(result.stderr)

export async function locate(directory: string): Promise<Location> {
  const show = ["git", "rev-parse", "--show-toplevel"]
  const root = await SandboxExec.run(show, { cwd: directory, env: ENGLISH })
  if (root.code !== 0) {
    if (!plainFolder(root)) throw notARepo(directory, root, show)
    return { source: "folder", root: await fs.realpath(directory), relative: "" }
  }
  const top = root.stdout.trim()
  const relative = path.relative(await fs.realpath(top), await fs.realpath(directory))
  const base = await SandboxExec.run(["git", "rev-parse", "--verify", "HEAD^{commit}"], { cwd: top, env: ENGLISH })
  // A repository with no commits has nothing to start from: it's copied as a folder.
  if (base.code !== 0) return { source: "folder", root: await fs.realpath(top), relative }
  return { source: "git", root: top, relative, base: base.stdout.trim() }
}

/**
 * What the sandbox starts from. In a repository: the current commit. In a folder: its contents now,
 * committed to the shadow (refs/lunos/base/<id> keeps that commit after the sandbox is gone).
 */
export async function repo(directory: string, options: { id?: string; limits?: Limits } = {}): Promise<Repo> {
  const found = await locate(directory)
  if (found.source === "folder") return snapshot(found, options)
  return {
    ...found,
    gitDir: (await git(["rev-parse", "--absolute-git-dir"], { cwd: found.root })).trim(),
  }
}

// ---- folders ----

/** Left out of a folder's copy unless one of its .gitignore files says otherwise (`!dist/`). */
export const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".tox/",
  "dist/",
  "build/",
  "target/",
  "out/",
  "bin/",
  "obj/",
  ".next/",
  ".nuxt/",
  ".angular/",
  ".svelte-kit/",
  ".turbo/",
  ".gradle/",
  ".cache/",
  "coverage/",
  ".terraform/",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "~$*",
  ".opencode/sandbox/",
]

/**
 * Files are stored and checked out exactly as they are: no line-ending conversion, and no filter
 * (Git LFS would turn a .docx into a pointer file). In info/attributes, which outranks the folder's
 * own .gitattributes.
 */
export const BYTE_EXACT = "* -text -filter -ident -working-tree-encoding\n"

export type Limits = { files: number; bytes: number }
/** What a folder's copy may hold before it's refused with "add a .gitignore". */
export const LIMITS: Limits = { files: 50_000, bytes: 2 * 1024 ** 3 }

export type Survey = { files: number; bytes: number }

/** Lunos's private git dir for a folder, keyed by its real path. */
export const shadowDir = (root: string) => path.join(Global.Path.state, "sandbox", "folders", Hash.fast(root))
const FOLDER_FILE = "lunos-folder.json"

/** Create or update a shadow git dir: its settings, the excludes and byte-exact attributes. */
async function prepareShadow(gitDir: string, root: string) {
  if (!existsSync(path.join(gitDir, "HEAD"))) {
    await fs.mkdir(path.dirname(gitDir), { recursive: true })
    await git(["init", "--quiet", "--bare", gitDir])
    // The settings upstream's snapshot uses, and gc off: a base is only kept by its ref.
    for (const [key, value] of [
      ["core.autocrlf", "false"],
      ["core.longpaths", "true"],
      ["core.fsmonitor", "false"],
      ["core.quotepath", "false"],
      ["gc.auto", "0"],
      ["user.name", "Lunos sandbox"],
      ["user.email", "sandbox@lunos.invalid"],
    ])
      await git(["--git-dir", gitDir, "config", key, value])
  }
  await fs.mkdir(path.join(gitDir, "info"), { recursive: true })
  await fs.writeFile(path.join(gitDir, "info", "attributes"), BYTE_EXACT)
  await fs.writeFile(path.join(gitDir, "info", "exclude"), DEFAULT_EXCLUDES.join("\n") + "\n")
  await fs.writeFile(path.join(gitDir, FOLDER_FILE), JSON.stringify({ root }) + "\n")
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MB`
      : `${Math.ceil(bytes / 1024)} KB`
export const describeSurvey = (survey: Survey) =>
  `${survey.files.toLocaleString("en")} file${survey.files === 1 ? "" : "s"}, ${size(survey.bytes)}`

/**
 * What a folder's copy would hold, after its .gitignore files and the default excludes. Refuses a
 * folder holding another repository (it would arrive as an empty folder) or more than `limits`.
 * `gitDir` is the shadow, or a throwaway one when nothing may be written (the doctor).
 */
async function survey(root: string, gitDir: string, limits: Limits): Promise<Survey> {
  const index = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-index-")), "index")
  const command = ["git", "--git-dir", gitDir, "--work-tree", root, "ls-files", "--others", "--exclude-standard", "-z"]
  try {
    const listed = (await SandboxExec.check(command, { cwd: root, env: { GIT_INDEX_FILE: index } }))
      .split("\0")
      .filter(Boolean)
    // git lists a folder holding its own repository as `dir/`, and would store it as an empty gitlink.
    const nested = listed.filter((item) => item.endsWith("/"))
    if (nested.length)
      throw new SandboxError({
        step: "detect",
        reason:
          `${root} holds other git repositories (${nested.slice(0, 5).join(", ")}${nested.length > 5 ? ", …" : ""}), ` +
          "which the sandbox would copy as empty folders",
        fix: `Start Lunos inside one of them, or list them in a .gitignore in ${root} to leave them out of the sandbox.`,
      })
    const files = `${listed.length.toLocaleString("en")} files`
    const tooBig = (over: string) =>
      new SandboxError({
        step: "detect",
        reason: `${root} is too big to copy into the sandbox: ${over} (the limit is ${limits.files.toLocaleString("en")} files / ${size(limits.bytes)})`,
        fix: `Add a .gitignore in ${root} listing what the sandbox doesn't need (build output, downloads, archives), then try again.`,
      })
    if (listed.length > limits.files) throw tooBig(files)
    let bytes = 0
    for (const file of listed) {
      bytes += lstatSync(path.join(root, file)).size
      // Counting stops here: the rest of a huge folder isn't read.
      if (bytes > limits.bytes) throw tooBig(`${files} / over ${size(limits.bytes)}`)
    }
    return { files: listed.length, bytes }
  } finally {
    await fs.rm(path.dirname(index), { recursive: true, force: true })
  }
}

/** The doctor's view of a folder: what would be copied, or why it can't be. Writes nothing lasting. */
export async function surveyFolder(root: string, limits: Limits = LIMITS) {
  const scratch = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-shadow-")), "git")
  try {
    await prepareShadow(scratch, root)
    return await survey(root, scratch, limits)
  } finally {
    await fs.rm(path.dirname(scratch), { recursive: true, force: true })
  }
}

/** Commit the folder's contents to its shadow as the base a sandbox starts from. */
async function snapshot(found: Location, options: { id?: string; limits?: Limits }): Promise<Repo> {
  const gitDir = shadowDir(found.root)
  await prepareShadow(gitDir, found.root)
  const counted = await survey(found.root, gitDir, options.limits ?? LIMITS)
  const content = await tree({ gitDir, workTree: found.root })
  const base = await commit({ gitDir, tree: content, message: `folder ${found.root}` })
  if (options.id) await git(["--git-dir", gitDir, "update-ref", baseRef(options.id), base])
  return { source: "folder", root: found.root, gitDir, base, relative: found.relative, survey: counted }
}

export const baseRef = (id: string) => `refs/lunos/base/${id}`

/**
 * A folder sandbox's results, from its shadow: found by id after the sandbox's own metadata is gone
 * (on_finish "destroy" removes it), so `lunos sandbox apply` still works then.
 */
export async function folderResult(id: string, branch: string) {
  const dir = path.join(Global.Path.state, "sandbox", "folders")
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const gitDir = path.join(dir, name)
    const result = await branchHead(gitDir, branch)
    if (!result) continue
    const base = await SandboxExec.run(["git", "--git-dir", gitDir, "rev-parse", "--verify", `${baseRef(id)}^{commit}`])
    const { root } = JSON.parse(await fs.readFile(path.join(gitDir, FOLDER_FILE), "utf8")) as { root: string }
    if (base.code === 0) return { gitDir, root, base: base.stdout.trim(), result }
  }
  return undefined
}

export type Applied = { written: string[]; deleted: string[]; unchanged: string[] }

/** Paths that differ between two trees (no rename detection: a rename is a delete and an add). */
async function differing(gitDir: string, from: string, to: string) {
  const out = await git(["--git-dir", gitDir, "diff", "--no-renames", "--name-status", "-z", from, to])
  const parts = out.split("\0").filter(Boolean)
  const files = new Map<string, string>()
  for (let index = 0; index + 1 < parts.length; index += 2) files.set(parts[index + 1], parts[index])
  return files
}

/**
 * Write a folder sandbox's results into the folder: every file the agent changed, taken from the
 * result tree (byte for byte), and its deletions. Refuses, writing nothing, when the user changed
 * any of those files on this machine since the sandbox started; a file that already holds the
 * agent's version is left alone, so applying twice is harmless.
 */
export async function applyFolder(input: {
  gitDir: string
  root: string
  base: string
  result: string
}): Promise<Applied> {
  if (!existsSync(input.root))
    throw new Error(`${input.root} doesn't exist any more, so there's nowhere to write the results`)
  const agent = await differing(input.gitDir, input.base, input.result)
  const host = await tree({ gitDir: input.gitDir, workTree: input.root })
  const user = await differing(input.gitDir, input.base, host)
  const done = await differing(input.gitDir, host, input.result)
  const unchanged = [...agent.keys()].filter((file) => !done.has(file))
  const conflicts = [...agent.keys()].filter((file) => user.has(file) && done.has(file))
  if (conflicts.length)
    throw new Error(
      `Nothing was written: since the sandbox started you changed ${conflicts.length === 1 ? "a file" : `${conflicts.length} files`} ` +
        `the agent also changed (${conflicts.slice(0, 10).join(", ")}${conflicts.length > 10 ? ", …" : ""}). ` +
        "Move your changes aside (or undo them), then run this again.",
    )
  const pending = [...agent].filter(([file]) => done.has(file))
  const write = pending.filter(([, status]) => status !== "D").map(([file]) => file)
  const remove = pending.filter(([, status]) => status === "D").map(([file]) => file)
  if (write.length) {
    const index = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-index-")), "index")
    try {
      // The shadow's info/attributes (BYTE_EXACT) applies: files arrive exactly as the agent left them.
      await git(
        [
          "--literal-pathspecs",
          "--git-dir",
          input.gitDir,
          "--work-tree",
          input.root,
          "checkout",
          input.result,
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { cwd: input.root, env: { GIT_INDEX_FILE: index }, input: write.join("\0") + "\0" },
      )
    } finally {
      await fs.rm(path.dirname(index), { recursive: true, force: true })
    }
  }
  for (const file of remove) await fs.rm(path.join(input.root, file), { force: true })
  return { written: write, deleted: remove, unchanged }
}

/**
 * XCOD-279: the repository as a file:// URL for git to fetch from (a plain path would ignore
 * --depth). On Windows `rev-parse` gives `D:/dir`, and `file://D:/dir` reads `D:` as a host name:
 * there it's `file:///D:/dir`.
 */
export function fileUrl(root: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return `file://${root}`
  const forward = root.replaceAll("\\", "/")
  return /^[A-Za-z]:/.test(forward) ? `file:///${forward}` : `file:${forward}`
}

/**
 * Build the workspace the sandbox starts with: a fresh repository holding only `base` (depth 1),
 * with the host's uncommitted changes (staged, unstaged and untracked-but-not-ignored) applied.
 */
export async function seed(input: Repo & { into: string; branch: string }) {
  await git(["init", "--quiet", input.into])
  // The workspace goes into a Linux container: check files out exactly as committed, whatever the
  // host's core.autocrlf says (it defaults to true on Windows, which would write CRLF).
  await git(["-C", input.into, "config", "core.autocrlf", "false"])
  await git(["-C", input.into, "config", "core.eol", "lf"])
  // A folder's files arrive byte for byte, whatever a .gitattributes in it says.
  if (input.source === "folder") await fs.writeFile(path.join(input.into, ".git", "info", "attributes"), BYTE_EXACT)
  const from = input.source === "folder" ? input.gitDir : input.root
  await git(["-C", input.into, "fetch", "--quiet", "--depth=1", fileUrl(from), input.base])
  await git(["-C", input.into, "checkout", "--quiet", "-b", input.branch, "FETCH_HEAD"])
  await git(["-C", input.into, "config", "user.name", "Lunos sandbox"])
  await git(["-C", input.into, "config", "user.email", "sandbox@lunos.invalid"])
  // A folder has no uncommitted changes: the base is all of it.
  if (input.source === "folder") return
  const diff = await git(["-C", input.root, "diff", "--binary", "HEAD"])
  if (diff.trim()) await git(["-C", input.into, "apply", "--whitespace=nowarn", "-"], { input: diff })
  const untracked = (await git(["-C", input.root, "ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
  for (const file of untracked) {
    const target = path.join(input.into, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.cp(path.join(input.root, file), target, { verbatimSymlinks: true })
  }
}

/** Tar command for a directory's contents, without macOS resource forks or extended attributes. */
export function tar(directory: string) {
  return ["tar", "--no-xattrs", "-c", "-f", "-", "-C", directory, "."]
}
export const TAR_ENV = { COPYFILE_DISABLE: "1" }

/**
 * Tree object for `workTree` as git would commit it with `git add -A`, starting from `startTree` so
 * files that are tracked but match .gitignore stay tracked (none: from nothing, for a folder). Writes objects into the host repo only.
 */
export async function tree(input: { gitDir: string; workTree: string; startTree?: string }) {
  const index = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-index-")), "index")
  const env = { GIT_INDEX_FILE: index }
  const args = ["--git-dir", input.gitDir, "--work-tree", input.workTree]
  try {
    await git([...args, "read-tree", ...(input.startTree ? [input.startTree] : ["--empty"])], { env })
    await git([...args, "add", "--all", "--", "."], { env })
    return (await git([...args, "write-tree"], { env })).trim()
  } finally {
    await fs.rm(path.dirname(index), { recursive: true, force: true })
  }
}

export async function treeOfCommit(gitDir: string, commit: string) {
  return (await git(["--git-dir", gitDir, "rev-parse", `${commit}^{tree}`])).trim()
}

async function identity(gitDir: string) {
  const name = await SandboxExec.run(["git", "--git-dir", gitDir, "config", "user.name"])
  const email = await SandboxExec.run(["git", "--git-dir", gitDir, "config", "user.email"])
  if (name.code === 0 && email.code === 0 && name.stdout.trim() && email.stdout.trim()) return {}
  return {
    GIT_AUTHOR_NAME: "Lunos sandbox",
    GIT_AUTHOR_EMAIL: "sandbox@lunos.invalid",
    GIT_COMMITTER_NAME: "Lunos sandbox",
    GIT_COMMITTER_EMAIL: "sandbox@lunos.invalid",
  }
}

export async function commit(input: { gitDir: string; tree: string; parent?: string; message: string }) {
  const parent = input.parent ? ["-p", input.parent] : []
  return (
    await git(["--git-dir", input.gitDir, "commit-tree", input.tree, ...parent, "-m", input.message], {
      env: await identity(input.gitDir),
    })
  ).trim()
}

export async function branchHead(gitDir: string, branch: string) {
  const result = await SandboxExec.run(["git", "--git-dir", gitDir, "rev-parse", "--verify", `refs/heads/${branch}`])
  return result.code === 0 ? result.stdout.trim() : undefined
}

/** Point `branch` at `commit`, but only if it is still at `expected` (undefined: must not exist). */
export async function setBranch(input: { gitDir: string; branch: string; commit: string; expected?: string }) {
  await git([
    "--git-dir",
    input.gitDir,
    "update-ref",
    "-m",
    "lunos sandbox handoff",
    `refs/heads/${input.branch}`,
    input.commit,
    input.expected ?? ZERO,
  ])
}

export async function changedFiles(gitDir: string, from: string, to: string) {
  return (await git(["--git-dir", gitDir, "diff", "--name-status", from, to]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t")
      return { status, path: rest.join(" -> ") }
    })
}

/**
 * XCOD-158: the changes between two trees as one binary-safe patch, which `git apply` takes. Used
 * for `sandbox.results: "patch"`, from the tree the sandbox started with, so it holds only what the
 * agent changed and applies on top of the user's own uncommitted work.
 */
export async function diff(gitDir: string, from: string, to: string) {
  return git(["--git-dir", gitDir, "diff", "--binary", "--full-index", from, to])
}

export * as SandboxGit from "./git"
