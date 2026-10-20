import path from "node:path"
import { existsSync } from "node:fs"
import { SandboxError, describe, diagnose } from "./error"

// XCOD-144: the one place the sandbox shells out (docker, git, tar). Arguments are always passed as
// an argv array, never through a shell (a Windows .cmd/.bat shim excepted, see `spawnable`).
//
// XCOD-279: the executable is resolved here, not left to the spawn: on Windows that finds
// docker.exe, falls back to where Docker Desktop and Podman install their CLI when PATH doesn't
// have it yet (installed after the terminal was opened), and turns "not found" into a SandboxError
// that says so. Every failure is a SandboxError with the command, its exit code and its stderr.

export type Result = { code: number; stdout: string; stderr: string; timedOut?: boolean }

export type Options = {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Bytes or text written to stdin, then closed. */
  input?: string
  /** Pipe another process's stdout into this one's stdin. */
  stdin?: ReadableStream<Uint8Array>
  /** Stop the command after this many milliseconds; the result then has `timedOut`. */
  timeout?: number
}

type Host = {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  which: (name: string, options: { PATH: string }) => string | null | undefined
  exists: (file: string) => boolean
}

const host = (): Host => ({ platform: process.platform, env: process.env, which: Bun.which, exists: existsSync })

/** An environment variable by name; on Windows names are case-insensitive (`Path` is `PATH`). */
export function envGet(env: Record<string, string | undefined>, name: string, platform = process.platform) {
  if (platform !== "win32") return env[name]
  const key = Object.keys(env).find((item) => item.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/**
 * `base` with `extra` on top. On Windows a variable differing only in case replaces the original
 * instead of sitting next to it: two `Path` entries in a child's environment leave which one wins
 * up to the C runtime.
 */
export function mergeEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string | undefined>,
  platform = process.platform,
) {
  if (platform !== "win32") return { ...base, ...extra }
  const names = new Set(Object.keys(extra).map((key) => key.toUpperCase()))
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !names.has(key.toUpperCase()))),
    ...extra,
  }
}

/** Where Docker Desktop and Podman put their CLI on Windows. */
export function knownLocations(name: string, env: Record<string, string | undefined>) {
  const roots = [...new Set([envGet(env, "ProgramFiles", "win32"), "C:\\Program Files"].filter(Boolean))] as string[]
  if (name === "docker")
    return roots.map((root) => path.win32.join(root, "Docker", "Docker", "resources", "bin", "docker.exe"))
  if (name === "podman") return roots.map((root) => path.win32.join(root, "RedHat", "Podman", "podman.exe"))
  return []
}

/**
 * The executable `name` runs: as given when it's a path, else from PATH (on Windows with its
 * extension: docker → docker.exe), else on Windows from a known install location. Undefined when
 * there's none.
 */
export function resolve(name: string, input: Host = host()) {
  if (/[\\/]/.test(name)) return name
  const found = input.which(name, { PATH: envGet(input.env, "PATH", input.platform) ?? "" })
  if (found) return found
  if (input.platform !== "win32") return undefined
  return knownLocations(name, input.env).find((file) => input.exists(file))
}

/**
 * One argument for `cmd.exe /d /s /c "…"`: quoted the way the program parses its command line, then
 * cmd's own metacharacters escaped with `^` (the rules cross-spawn uses).
 */
export function cmdQuote(arg: string) {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`
  return quoted.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1")
}

/**
 * How to spawn `file args`: directly, or, for a Windows .cmd/.bat shim (which only cmd.exe runs),
 * through cmd.exe with every argument quoted for it, so `{{json .}}` or `a|b` reach the program intact.
 */
export function spawnable(file: string, args: readonly string[], platform = process.platform, comspec = "cmd.exe") {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { argv: [file, ...args], verbatim: false }
  const line = [file.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1"), ...args.map(cmdQuote)].join(" ")
  return { argv: [comspec, "/d", "/s", "/c", `"${line}"`], verbatim: true }
}

const cache = new Map<string, string | undefined>()

function prepare(cmd: string[]) {
  const env = host().env
  const key = `${cmd[0]}\0${envGet(env, "PATH") ?? ""}`
  if (!cache.has(key)) cache.set(key, resolve(cmd[0]))
  const file = cache.get(key)
  if (!file) {
    const runtime = cmd[0] === "docker" || cmd[0] === "podman"
    throw new SandboxError({
      reason: `the ${cmd[0]} command wasn't found on PATH`,
      command: cmd,
      fix: runtime
        ? diagnose("command was not found")
        : `Install ${cmd[0]} and make sure it's on PATH, then try again.`,
    })
  }
  return spawnable(file, cmd.slice(1), process.platform, envGet(env, "ComSpec") ?? "cmd.exe")
}

export async function run(cmd: string[], options: Options = {}): Promise<Result> {
  const target = prepare(cmd)
  let proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">
  try {
    proc = Bun.spawn(target.argv, {
      cwd: options.cwd,
      env: options.env ? mergeEnv(process.env, options.env) : process.env,
      stdin: options.stdin ?? (options.input !== undefined ? new Blob([options.input]) : "ignore"),
      stdout: "pipe",
      stderr: "pipe",
      windowsVerbatimArguments: target.verbatim,
    }) as Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">
  } catch (error) {
    throw new SandboxError({ reason: `${cmd[0]} couldn't be started: ${describe(error)}`, command: cmd })
  }
  let timedOut = false
  const timer = options.timeout
    ? setTimeout(() => {
        timedOut = true
        proc.kill()
      }, options.timeout)
    : undefined
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (!timedOut) return { code, stdout, stderr }
    const note = `no answer within ${options.timeout! / 1000}s, so it was stopped`
    return { code, stdout, stderr: stderr.trim() ? `${stderr.trim()}\n(${note})` : note, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** The SandboxError for a command that failed: its first line of output as the reason. */
export function failure(cmd: readonly string[], result: Result) {
  const output = result.stderr.trim() || result.stdout.trim()
  const first = output.split(/\r?\n/).find((line) => line.trim())
  return new SandboxError({
    reason: `${cmd.slice(0, 3).join(" ")} failed${first ? `: ${first.trim()}` : ` with exit code ${result.code}`}`,
    command: cmd,
    code: result.code,
    stderr: output,
  })
}

/** Like `run`, but throws a SandboxError with the command's stderr when it fails. */
export async function check(cmd: string[], options: Options = {}): Promise<string> {
  const result = await run(cmd, options)
  if (result.code !== 0) throw failure(cmd, result)
  return result.stdout
}

/** Run `from | to` and fail if either side fails. */
export async function pipe(from: string[], to: string[], options: { from?: Options; to?: Options } = {}) {
  const target = prepare(from)
  let source: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    source = Bun.spawn(target.argv, {
      cwd: options.from?.cwd,
      env: options.from?.env ? mergeEnv(process.env, options.from.env) : process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsVerbatimArguments: target.verbatim,
    })
  } catch (error) {
    throw new SandboxError({ reason: `${from[0]} couldn't be started: ${describe(error)}`, command: from })
  }
  const [sink, sourceErr, sourceCode] = await Promise.all([
    run(to, { ...options.to, stdin: source.stdout }),
    new Response(source.stderr).text(),
    source.exited,
  ]).catch((error: unknown) => {
    source.kill()
    throw error
  })
  if (sourceCode !== 0) throw failure(from, { code: sourceCode, stdout: "", stderr: sourceErr })
  if (sink.code !== 0) throw failure(to, sink)
  return sink.stdout
}

export * as SandboxExec from "./exec"
