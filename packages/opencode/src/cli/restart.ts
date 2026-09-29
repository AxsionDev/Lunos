export * as Restart from "./restart"

import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { AuditLog } from "@/audit/log"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { Restarted, RestartRequest } from "@opencode-ai/tui/util/restart"

/**
 * XCOD-129: relaunching Lunos for `/restart`.
 *
 * The TUI asks for a restart (see `@opencode-ai/tui/util/restart`); once it has exited and the
 * worker is shut down (MCP servers, LSP servers, the memory sidecar and the local server are
 * stopped by instance disposal), the command that started it calls `relaunch`. That runs Lunos
 * again with the same executable, arguments, working directory and environment, plus
 * `--session <id>`:
 *
 * - Linux/macOS/WSL: exec in place (`process.execve`), so the PID, the terminal's foreground
 *   process group and any wrapper waiting on the PID (the npm `lunos` shim) are unchanged.
 * - Windows has no exec: the new process is spawned attached to the same console, and this one
 *   stays as a thin waiter and exits with its exit code. Exiting at once would hand the console
 *   back to the shell, which would then fight the new Lunos for keyboard input.
 *
 * A handoff file carries the session, the unsent draft and the old version to the new process. If
 * the new process fails to start, it prints the error and the command to start Lunos by hand; it
 * never restarts itself, so a broken start can't loop.
 */

/** Names the handoff file for the relaunched process. Removed from its environment on read. */
export const HANDOFF_ENV = "LUNOS_RESTART_HANDOFF"
/** How long the relaunched Lunos gets to load its session before it gives up. */
export const START_TIMEOUT = 60_000
/** How long `<new lunos> --version` gets before the relaunch is abandoned. */
export const PREFLIGHT_TIMEOUT = 15_000

/**
 * The environment Lunos was started with, taken before the CLI middleware adds its own
 * `OPENCODE=1`/`AGENT=1`/`OPENCODE_PID` markers, so the relaunch doesn't think it runs inside Lunos.
 */
const launchEnv: Record<string, string | undefined> = { ...process.env }
const launchCwd = process.cwd()

export type Handoff = Restarted & {
  v: 1
  sessionID?: string
  /** The manual command, printed if this start fails. */
  manual: string
}

/** Options that pick the session or the first prompt; the relaunch sets its own. */
const VALUE_OPTIONS = new Set(["--session", "-s", "--prompt"])
const FLAG_OPTIONS = new Set(["--continue", "-c", "--fork", "--no-continue", "--no-fork"])

/**
 * The user's arguments for the relaunch: drop `--session`, `--continue`, `--fork` and `--prompt`
 * in any spelling (`--x v`, `--x=v`, `-s v`), then add `--session <id>` unless `--fresh`.
 * `--prompt` goes because the TUI would send it again.
 */
export function relaunchArgs(args: readonly string[], input: { sessionID?: string; fresh: boolean }) {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") {
      out.push(...args.slice(i))
      break
    }
    const name = arg.startsWith("-") ? arg.split("=")[0] : arg
    if (VALUE_OPTIONS.has(name)) {
      if (!arg.includes("=")) i++
      continue
    }
    if (FLAG_OPTIONS.has(name)) continue
    out.push(arg)
  }
  if (!input.fresh && input.sessionID) {
    const at = out.indexOf("--")
    const add = ["--session", input.sessionID]
    if (at === -1) out.push(...add)
    else out.splice(at, 0, ...add)
  }
  return out
}

/** A `bun build --compile` binary: its entry point lives in Bun's embedded filesystem. */
export function isCompiled(entry: string | undefined) {
  if (!entry) return false
  return entry.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(entry)
}

export type Command = {
  /** The executable. */
  file: string
  /** What goes before the user's arguments: `[entry.ts]` when running from source, else empty. */
  base: string[]
  /** The user's arguments (with `--session <id>`). */
  args: string[]
  /** Set when `file` is a Windows `.cmd`/`.bat` shim, which only `cmd.exe` can run. */
  shim?: boolean
}

/**
 * Which Lunos to start. Normally the same executable (`process.execPath`, plus the entry script
 * when running from source). After `/update`, the new install is found on PATH, since the update
 * put it wherever the install method keeps `lunos`, not necessarily at the old `execPath`. The
 * same goes when the old executable is gone.
 */
export function resolveCommand(input: {
  execPath: string
  argv: readonly string[]
  execArgv: readonly string[]
  args: string[]
  upgraded: boolean
  platform: NodeJS.Platform
  which: (name: string) => string | null | undefined
  exists: (file: string) => boolean
}): Command {
  const compiled = isCompiled(input.argv[1])
  if (compiled && (input.upgraded || !input.exists(input.execPath))) {
    const found = input.which("lunos")
    if (found) return { file: found, base: [], args: input.args, shim: isShim(found, input.platform) }
  }
  return {
    file: input.execPath,
    base: compiled ? [] : [...input.execArgv, input.argv[1]].filter((item): item is string => Boolean(item)),
    args: input.args,
  }
}

function isShim(file: string, platform: NodeJS.Platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file)
}

/** Quote one argument for the user's shell, for the manual command. */
export function quote(arg: string, platform: NodeJS.Platform) {
  if (platform === "win32") return /[\s"&|<>^]/.test(arg) || arg === "" ? `"${arg.replaceAll('"', '""')}"` : arg
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/** The exact command to start Lunos by hand, as printed when the relaunch fails. */
export function manualCommand(command: Command, platform: NodeJS.Platform) {
  return [command.file, ...command.base, ...command.args].map((arg) => quote(arg, platform)).join(" ")
}

/** `cmd.exe /d /s /c "<shim> args"`, the only way to run a `.cmd` shim, with its own quoting. */
export function spawnArgv(command: Command, platform: NodeJS.Platform, comspec = "cmd.exe") {
  if (!command.shim) return { argv: [command.file, ...command.base, ...command.args], verbatim: false }
  const line = [command.file, ...command.base, ...command.args].map((arg) => quote(arg, platform)).join(" ")
  return { argv: [comspec, "/d", "/s", "/c", `"${line}"`], verbatim: true }
}

export function handoffPath(state = Global.Path.state) {
  return path.join(state, `restart-${process.pid}-${Date.now()}.json`)
}

export function writeHandoff(file: string, handoff: Handoff) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(handoff), { mode: 0o600 })
}

let taken: Handoff | undefined
let started = false

/**
 * Read and delete the handoff, if this process is a relaunch. The variable leaves `process.env`
 * first, so the worker, shells and MCP servers started from here never see it.
 */
export function takeHandoff(env: Record<string, string | undefined> = process.env): Handoff | undefined {
  const file = env[HANDOFF_ENV]
  if (!file) return
  delete env[HANDOFF_ENV]
  delete launchEnv[HANDOFF_ENV]
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Handoff
    if (parsed?.v !== 1) return
    taken = parsed
    return parsed
  } catch {
    return
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** The relaunched TUI loaded its session: a later failure is an ordinary one, not a failed start. */
export function markStarted() {
  started = true
}

/**
 * Called on the way out after an error. If this process is a relaunch that never finished
 * starting, say so and print the command to run by hand. Nothing is retried.
 */
export function reportFailedStart(write: (text: string) => void = (text) => process.stderr.write(text)) {
  if (!taken || started) return false
  started = true
  write(
    `\nLunos didn't start again after /restart. Nothing will be retried.\nStart it yourself with:\n  ${taken.manual}\n`,
  )
  return true
}

/**
 * Terminal modes the TUI may have left on if it didn't exit cleanly: mouse tracking, the alternate
 * screen, a hidden cursor. Written synchronously so it reaches the terminal before exec.
 */
export const TERMINAL_RESET = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h"

/** Write straight to the terminal, bypassing buffered streams. */
export function write(text: string) {
  try {
    fs.writeSync(1, text)
  } catch {}
}

export type RelaunchDeps = {
  platform: NodeJS.Platform
  execve: (file: string, argv: string[], env: Record<string, string | undefined>) => never | void
  spawn: (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined>; verbatim: boolean },
  ) => Promise<number>
  preflight: (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined>; verbatim: boolean },
  ) => { ok: true; version: string } | { ok: false; error: string }
  /** Terminal output (the reset sequence). */
  write: (text: string) => void
  /** Error output. */
  error: (text: string) => void
  exit: (code: number) => never | void
  /** Flush what must not be lost to exec (the audit trail). */
  flush?: () => Promise<void>
}

/**
 * Start Lunos again. On success this never returns on Linux/macOS (the process is replaced) and
 * exits with the new process's code on Windows. On failure it prints why and the manual command,
 * and exits 1: there is no second attempt.
 */
export async function relaunch(
  request: RestartRequest & { attach?: string },
  deps: RelaunchDeps = defaultDeps(),
  input: {
    execPath?: string
    argv?: readonly string[]
    execArgv?: readonly string[]
    env?: Record<string, string | undefined>
    cwd?: string
    handoff?: string
  } = {},
) {
  const argv = input.argv ?? process.argv
  const env = { ...(input.env ?? launchEnv) }
  const cwd = input.cwd ?? launchCwd
  const command = resolveCommand({
    execPath: input.execPath ?? process.execPath,
    argv,
    execArgv: input.execArgv ?? process.execArgv,
    args: relaunchArgs(argv.slice(2), request),
    upgraded: Boolean(request.upgraded),
    platform: deps.platform,
    which: (name) => Bun.which(name, { PATH: env.PATH ?? env.Path ?? "" }),
    exists: (file) => fs.existsSync(file),
  })
  const manual = manualCommand(command, deps.platform)
  const fail = (reason: string) => {
    deps.write(TERMINAL_RESET)
    deps.error(`Lunos couldn't restart: ${reason}\nNothing will be retried. Start it yourself with:\n  ${manual}\n`)
    return deps.exit(1)
  }

  const spawn = spawnArgv(command, deps.platform, env.ComSpec ?? env.COMSPEC)
  const check = deps.preflight(
    spawnArgv({ ...command, args: ["--version"] }, deps.platform, env.ComSpec ?? env.COMSPEC).argv,
    { cwd, env, verbatim: spawn.verbatim },
  )
  if (!check.ok) return fail(check.error)

  const file = input.handoff ?? handoffPath()
  try {
    writeHandoff(file, {
      v: 1,
      from: InstallationVersion,
      sessionID: request.fresh ? undefined : request.sessionID,
      fresh: request.fresh,
      draft: request.draft,
      cancelled: request.cancelled,
      attach: request.attach,
      manual,
    })
  } catch (error) {
    return fail(`couldn't save the session handoff (${error instanceof Error ? error.message : String(error)})`)
  }
  env[HANDOFF_ENV] = file
  await deps.flush?.()
  deps.write(TERMINAL_RESET)

  if (deps.platform !== "win32") {
    try {
      deps.execve(spawn.argv[0], spawn.argv, env)
    } catch (error) {
      fs.rmSync(file, { force: true })
      return fail(error instanceof Error ? error.message : String(error))
    }
    return
  }

  const code = await deps.spawn(spawn.argv, { cwd, env, verbatim: spawn.verbatim }).catch((error: unknown) => {
    fs.rmSync(file, { force: true })
    fail(error instanceof Error ? error.message : String(error))
    return 1
  })
  return deps.exit(code)
}

export function defaultDeps(): RelaunchDeps {
  return {
    platform: process.platform,
    execve: (file, argv, env) => {
      process.chdir(launchCwd)
      process.execve!(file, argv, env as NodeJS.ProcessEnv)
    },
    async spawn(argv, options) {
      // Console Ctrl+C and Ctrl+Break reach every process attached to the console. This one only
      // waits; if it died, the shell would take the console back from the new Lunos.
      const ignore = () => {}
      process.on("SIGINT", ignore)
      process.on("SIGBREAK", ignore)
      const child = Bun.spawn(argv, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["inherit", "inherit", "inherit"],
        windowsVerbatimArguments: options.verbatim,
      })
      return await child.exited
    },
    preflight(argv, options) {
      try {
        const result = Bun.spawnSync(argv, {
          cwd: options.cwd,
          env: options.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: PREFLIGHT_TIMEOUT,
          windowsVerbatimArguments: options.verbatim,
        })
        if (result.exitCode === 0) return { ok: true, version: result.stdout.toString().trim() }
        const stderr = result.stderr.toString().trim().split("\n").slice(-5).join("\n")
        if (result.exitCode === null)
          return { ok: false, error: `the new Lunos didn't answer within ${PREFLIGHT_TIMEOUT / 1000}s` }
        return { ok: false, error: `the new Lunos exited with code ${result.exitCode}${stderr ? `:\n${stderr}` : ""}` }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    write: (text) => {
      try {
        fs.writeSync(1, text)
      } catch {}
    },
    error: (text) => {
      try {
        fs.writeSync(2, text)
      } catch {}
    },
    exit: (code) => process.exit(code),
    flush: async () => {
      await Promise.race([AuditLog.flush(), Bun.sleep(3000)])
    },
  }
}
