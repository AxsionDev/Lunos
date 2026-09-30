import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SandboxExec } from "./exec"

// XCOD-144: the git side of copy mode and of the result handoff. The host repository's working tree,
// index and HEAD are never touched: trees are built with a throwaway index file, and the only write
// to the host repo is the new `lunos/sandbox/<id>` ref (plus the objects it points at).

const git = (args: string[], options?: SandboxExec.Options) => SandboxExec.check(["git", ...args], options)

const ZERO = "0000000000000000000000000000000000000000"

export type Repo = {
  /** Top of the working tree. */
  root: string
  /** Absolute git dir (for a linked worktree, its own git dir; objects are shared). */
  gitDir: string
  /** The commit the sandbox starts from. */
  base: string
  /** Where the user is, relative to `root` ("" at the top). */
  relative: string
}

export async function repo(directory: string): Promise<Repo> {
  const root = await SandboxExec.run(["git", "rev-parse", "--show-toplevel"], { cwd: directory })
  if (root.code !== 0)
    throw new Error(`The sandbox copies a git repository into the container, and ${directory} isn't in one`)
  const top = root.stdout.trim()
  const base = await SandboxExec.run(["git", "rev-parse", "--verify", "HEAD^{commit}"], { cwd: top })
  if (base.code !== 0) throw new Error("The sandbox starts from the current commit, and this repository has none yet")
  return {
    root: top,
    gitDir: (await git(["rev-parse", "--absolute-git-dir"], { cwd: top })).trim(),
    base: base.stdout.trim(),
    relative: path.relative(await fs.realpath(top), await fs.realpath(directory)),
  }
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
  await git(["-C", input.into, "fetch", "--quiet", "--depth=1", `file://${input.root}`, input.base])
  await git(["-C", input.into, "checkout", "--quiet", "-b", input.branch, "FETCH_HEAD"])
  await git(["-C", input.into, "config", "user.name", "Lunos sandbox"])
  await git(["-C", input.into, "config", "user.email", "sandbox@lunos.invalid"])
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
 * files that are tracked but match .gitignore stay tracked. Writes objects into the host repo only.
 */
export async function tree(input: { gitDir: string; workTree: string; startTree: string }) {
  const index = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-index-")), "index")
  const env = { GIT_INDEX_FILE: index }
  const args = ["--git-dir", input.gitDir, "--work-tree", input.workTree]
  try {
    await git([...args, "read-tree", input.startTree], { env })
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

export async function commit(input: { gitDir: string; tree: string; parent: string; message: string }) {
  return (
    await git(["--git-dir", input.gitDir, "commit-tree", input.tree, "-p", input.parent, "-m", input.message], {
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

export * as SandboxGit from "./git"
