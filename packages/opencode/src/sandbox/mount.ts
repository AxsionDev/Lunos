import os from "node:os"
import path from "node:path"
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { SandboxExec } from "./exec"
import { SandboxDocker } from "./docker"

// XCOD-158: what gets mounted into a sandbox from this machine. In `workspace: "mount"` that's your
// working tree, read-write, with the paths that would let the agent run code on this machine later
// mounted read-only over it: .git (hooks, config) and Lunos's own config (plugins, commands, which
// the next `lunos` outside a sandbox would load). And sandbox.mounts: extra directories, read-only,
// checked here so none of them hands the sandbox your keys or a container runtime's socket.

/** Under your working tree, mounted read-only over it when they exist. */
export const PROTECTED = [".git", ".opencode", "opencode.json", "opencode.jsonc"]

/**
 * The git directories a linked worktree's `.git` file points at (its own, and the main repository's
 * common one). They are outside the tree, so they're mounted read-only at the same path, or git
 * inside the sandbox couldn't find them.
 */
export async function gitDirsOutside(root: string): Promise<string[]> {
  const dotGit = path.join(root, ".git")
  if (!existsSync(dotGit) || !lstatSync(dotGit).isFile()) return []
  const out = await SandboxExec.check([
    "git",
    "-C",
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ])
  // git prints C:/forward/slashes on Windows: compare in this platform's form.
  const inside = (dir: string) => dir === root || dir.startsWith(root + path.sep)
  return Array.from(
    new Set(
      out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => path.resolve(line)),
    ),
  ).filter((dir) => !inside(dir))
}

/** Your working tree's mounts for `workspace: "mount"`. */
export async function workspace(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Pick<SandboxDocker.Binds, "root" | "protect" | "outside">> {
  const outside = await gitDirsOutside(root)
  // A linked worktree's .git names its git directories by Windows paths there, which git in a Linux
  // container can't open, so they can't be mounted where git expects them.
  if (outside.length && platform === "win32")
    throw new Error(
      'sandbox.workspace "mount" isn\'t supported in a linked git worktree on Windows: its git directories ' +
        `(${outside.join(", ")}) are Windows paths, which git in the sandbox can't use. Use "copy", or the main checkout.`,
    )
  return {
    root,
    protect: PROTECTED.filter((item) => existsSync(path.join(root, item))),
    outside,
  }
}

const SANDBOX_PATHS = [SandboxDocker.ROOT, SandboxDocker.POLICY_DIR, SandboxDocker.RUNTIME_DIR]

/** Whether `inner` is `outer` or inside it. */
const within = (inner: string, outer: string, sep: string = path.sep) =>
  inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)
/** For paths in the sandbox: always POSIX, whatever this machine is. */
const withinSandbox = (inner: string, outer: string) => within(inner, outer, "/")

const real = (item: string) => {
  try {
    return realpathSync(item)
  } catch {
    return item
  }
}

/**
 * Check sandbox.mounts. A source must exist and be absolute; it is refused when it is `/` or your
 * home directory itself, holds SSH or GPG keys or Docker's credentials, or holds a container
 * runtime's socket (which would let the sandbox start containers on this machine). A target must be
 * an absolute container path outside the sandbox's own directories.
 */
export function extra(
  mounts: readonly { source: string; target: string }[],
  env: { home?: string; runtimeDir?: string } = { home: os.homedir(), runtimeDir: process.env.XDG_RUNTIME_DIR },
) {
  const home = env.home ? real(env.home) : undefined
  const secrets = home ? [".ssh", ".gnupg", ".docker"].map((item) => path.join(home, item)) : []
  const sockets = [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/podman",
    ...(env.runtimeDir ? [env.runtimeDir] : []),
  ]
  return mounts.map((item) => {
    const refuse = (why: string) => new Error(`sandbox.mounts: ${item.source} can't be mounted into a sandbox: ${why}`)
    if (!path.isAbsolute(item.source)) throw refuse("the source must be an absolute path")
    if (!existsSync(item.source)) throw refuse("it doesn't exist")
    const source = real(item.source)
    if (source === path.parse(source).root) throw refuse("it's the whole filesystem")
    if (home && source === home) throw refuse("it's your whole home directory; mount the directory you need")
    for (const secret of secrets)
      if (within(source, secret) || within(secret, source)) throw refuse(`it holds or is inside ${secret}`)
    for (const socket of sockets)
      if (within(socket, source) || within(source, socket))
        throw refuse(
          `it holds a container runtime's socket (${socket}), which would let the sandbox start containers here`,
        )
    const target = path.posix.normalize(item.target)
    if (!path.posix.isAbsolute(item.target) || target === "/")
      throw refuse(`the target ${item.target} must be an absolute path in the sandbox, other than /`)
    for (const reserved of SANDBOX_PATHS)
      if (withinSandbox(target, reserved) || withinSandbox(reserved, target))
        throw refuse(`the target ${target} overlaps the sandbox's own ${reserved}`)
    return { source, target }
  })
}

export * as SandboxMount from "./mount"
