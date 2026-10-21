import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SandboxExec } from "./exec"
import { SandboxError } from "./error"

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
  if (/not a git repository/i.test(result.stderr) || !result.stderr.trim())
    return new SandboxError({
      ...fields,
      reason: `The sandbox copies a git repository into the container, and ${directory} isn't in one`,
    })
  return new SandboxError({ ...fields, reason: `Git couldn't read the repository at ${directory}` })
}

export async function repo(directory: string): Promise<Repo> {
  const show = ["git", "rev-parse", "--show-toplevel"]
  const root = await SandboxExec.run(show, { cwd: directory })
  if (root.code !== 0) throw notARepo(directory, root, show)
  const top = root.stdout.trim()
  const verify = ["git", "rev-parse", "--verify", "HEAD^{commit}"]
  const base = await SandboxExec.run(verify, { cwd: top })
  if (base.code !== 0)
    throw new SandboxError({
      step: "detect",
      reason: "The sandbox starts from the current commit, and this repository has none yet",
      command: verify,
      code: base.code,
      stderr: base.stderr,
    })
  return {
    root: top,
    gitDir: (await git(["rev-parse", "--absolute-git-dir"], { cwd: top })).trim(),
    base: base.stdout.trim(),
    relative: path.relative(await fs.realpath(top), await fs.realpath(directory)),
  }
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
  await git(["-C", input.into, "fetch", "--quiet", "--depth=1", fileUrl(input.root), input.base])
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

/**
 * XCOD-158: the changes between two trees as one binary-safe patch, which `git apply` takes. Used
 * for `sandbox.results: "patch"`, from the tree the sandbox started with, so it holds only what the
 * agent changed and applies on top of the user's own uncommitted work.
 */
export async function diff(gitDir: string, from: string, to: string) {
  return git(["--git-dir", gitDir, "diff", "--binary", "--full-index", from, to])
}

export * as SandboxGit from "./git"
