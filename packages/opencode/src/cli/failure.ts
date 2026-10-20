export * as Failure from "./failure"

import fs from "node:fs"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import { parse } from "jsonc-parser"
import { RunLog } from "@opencode-ai/core/observability/run-log"
import { StartupTrace } from "@opencode-ai/core/startup-trace"
import { ConfigLog } from "@opencode-ai/core/config/log"
import { ConfigManaged } from "@/config/managed"
import { SandboxConfig } from "@/sandbox/config"
import { FormatUnknownError } from "./error"

/**
 * When Lunos fails, the error ends with where its full details are and how to report it:
 *
 *   Full log: /…/log/lunos-2026-10-20-1412-a3f9.log
 *   Report it: lunos bug-report a3f9
 *
 * `start` opens this run's log (`RunLog`) before anything else runs. A failure anywhere is recorded
 * with `record` (or `RunLog.failure`, from packages that can't import this one). On the way out, a
 * run with a recorded failure prints the footer once, after putting the terminal back in order.
 */

/** Commands that don't get a run log of their own: looking at logs mustn't push the logs out. */
const QUIET = new Set(["logs", "bug-report", "completion"])

/**
 * What a TUI that didn't exit cleanly leaves on: mouse tracking, bracketed paste, a hidden cursor,
 * the alternate screen. Only written while the TUI is up: leaving an alternate screen that isn't
 * there moves the cursor back over what was printed since.
 */
const RESTORE = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l"
let fullscreen = false

/** The TUI is on screen (true) or has put the terminal back itself (false). */
export function setFullscreen(value: boolean) {
  fullscreen = value
}

/** Whether `args` (the CLI's arguments) get a run log. */
export function wanted(args: readonly string[]) {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) return false
  const [command, sub] = args.filter((arg) => !arg.startsWith("-"))
  if (command && QUIET.has(command)) return false
  // Claude Code and Codex start `lunos mcp bridge` for every turn.
  if (command === "mcp" && sub === "bridge") return false
  return true
}

const isDoc = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** `log` from your global config and the organisation's managed config; a managed lock wins outright. */
export function retention(global = SandboxConfig.globalDoc(), managed = managedDoc()) {
  const locked = Array.isArray(managed.$locked) && managed.$locked.includes("log")
  const block = locked
    ? managed.log
    : { ...(isDoc(global.log) ? global.log : {}), ...(isDoc(managed.log) ? managed.log : {}) }
  try {
    const info = Schema.decodeUnknownSync(ConfigLog.Info)(block ?? {})
    return { days: info.retention_days, maxMb: info.max_mb }
  } catch {
    return {}
  }
}

function managedDoc() {
  try {
    return SandboxConfig.mergeDocs(ConfigManaged.readManagedDocsSync())
  } catch {
    return {}
  }
}

/** Config files that exist for this directory, lowest precedence first: paths only. */
function layers(directory: string) {
  const files = SandboxConfig.files(directory, SandboxConfig.worktreeOf(directory)).filter((file) =>
    fs.existsSync(file),
  )
  const managed = ConfigManaged.managedConfigDir()
  return [
    ...files,
    ...(process.env.OPENCODE_CONFIG_CONTENT ? ["OPENCODE_CONFIG_CONTENT (environment)"] : []),
    ...(fs.existsSync(managed) ? [`${managed} (managed)`] : []),
  ]
}

const SECRET_KEY = /(?:api.?key|secret|password|token$|authorization$|cookie$|credential|private.?key)/i

/**
 * Secrets the config files name, so the log never shows them however they turn up: the values of
 * `{env:NAME}` references, and literal values of secret-looking keys (`apiKey`, …).
 */
function configSecrets(files: readonly string[]) {
  const texts = files.flatMap((file) => {
    if (!fs.existsSync(file)) return []
    try {
      return [fs.readFileSync(file, "utf8")]
    } catch {
      return []
    }
  })
  if (process.env.OPENCODE_CONFIG_CONTENT) texts.push(process.env.OPENCODE_CONFIG_CONTENT)
  const walk = (value: unknown, key = ""): void => {
    if (typeof value === "string") return SECRET_KEY.test(key) ? RunLog.secret(value) : undefined
    if (Array.isArray(value)) return value.forEach((item) => walk(item))
    if (isDoc(value)) for (const [name, item] of Object.entries(value)) walk(item, name)
  }
  for (const text of texts) {
    for (const match of text.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) RunLog.secret(process.env[match[1]!])
    walk(parse(text, [], { allowTrailingComma: true }))
  }
}

/**
 * Open this run's log, prune old ones, and make sure a failure, however Lunos ends, says where
 * the log is. Called first thing by the CLI.
 */
/** Make every secret the config for `directory` names one the run log redacts; returns the config files. */
export function secrets(directory: string) {
  const found = layers(directory)
  configSecrets(found)
  return found
}

export function start(args: readonly string[], directory = process.env.PWD ?? process.cwd()) {
  if (!wanted(args) || RunLog.current()) return
  const found = secrets(directory)
  RunLog.start({ argv: args, lines: { cwd: directory } })
  // XCOD-276: the log header carries the start-up timeline recorded so far.
  RunLog.setPhases(() => StartupTrace.format())
  RunLog.note("config layers", found.length ? found : "(none)")
  RunLog.prune(retention())
  process.on("exit", (code) => {
    footer()
    RunLog.finish(code)
  })
  process.on("uncaughtException", (error) => unhandled("an unhandled exception", error, "uncaughtException"))
  process.on("unhandledRejection", (error) => unhandled("an unhandled promise rejection", error, "unhandledRejection"))
}

/**
 * Bun ends the process on an unhandled error, and so does this, with the log and its link. While
 * something else handles them too (the TUI keeps running and shows them in its console), the error
 * only goes to the log.
 */
function unhandled(kind: string, error: unknown, event: "uncaughtException" | "unhandledRejection") {
  if (process.listenerCount(event) > 1) {
    RunLog.note(`${kind} (Lunos kept running)`, RunLog.describe(error))
    return
  }
  record(kind, error, `Lunos stopped because of an unexpected error: ${FormatUnknownError(error)}`)
  process.exit(1)
}

let diagnosed = false

/** For a failure that involved the sandbox's container runtime: its version, `info` and context. */
function runtimeDiagnostics() {
  if (diagnosed) return
  for (const bin of ["docker", "podman"] as const) {
    if (!RunLog.ran(bin)) continue
    diagnosed = true
    const info =
      bin === "podman"
        ? "OSType={{.Host.OS}} Version={{.Version.Version}} Rootless={{.Host.Security.Rootless}}"
        : "OSType={{.OSType}} ServerVersion={{.ServerVersion}} OperatingSystem={{.OperatingSystem}} Name={{.Name}}"
    const commands = [
      [bin, "version"],
      [bin, "info", "--format", info],
      ...(bin === "docker" ? [["docker", "context", "show"]] : []),
    ]
    for (const cmd of commands) {
      try {
        const result = Bun.spawnSync(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 })
        RunLog.note(
          `${cmd.join(" ")} (exit ${result.exitCode ?? "none"})`,
          [result.stdout.toString().trim(), result.stderr.toString().trim()].filter(Boolean).join("\n") ||
            "(no output)",
        )
      } catch (error) {
        RunLog.note(cmd.join(" "), `couldn't run it: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * A failure in this run: the full error (stack, cause chain, a command's output) goes to the log.
 * `headline` is shown above the footer when nothing else has shown the error on screen.
 */
export function record(step: string, error: unknown, headline?: string) {
  RunLog.failure(step, error, { headline })
  runtimeDiagnostics()
}

/** Whether this terminal shows OSC 8 hyperlinks; elsewhere the path is plain text. */
export function hyperlinks(env: Record<string, string | undefined> = process.env, tty = !!process.stderr.isTTY) {
  if (env.FORCE_HYPERLINK !== undefined) return env.FORCE_HYPERLINK !== "0"
  if (!tty || env.CI || env.TERM === "dumb" || env.TMUX || env.STY) return false
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION || env.WEZTERM_PANE) return true
  if (["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby"].includes(env.TERM_PROGRAM ?? "")) return true
  if (["xterm-kitty", "xterm-ghostty", "alacritty", "wezterm"].includes(env.TERM ?? "")) return true
  // GNOME Terminal, Tilix and other VTE terminals since 0.50.
  return Number(env.VTE_VERSION ?? 0) >= 5000
}

/** `file` as a clickable `file://` link where the terminal supports it, else the plain path. */
export function link(file: string, supported = hyperlinks()) {
  if (!supported) return file
  return `\x1b]8;;${pathToFileURL(file).href}\x1b\\${file}\x1b]8;;\x1b\\`
}

/** The lines that end a failure's output. */
export function lines(log: { id: string; file: string }, headline?: string, supported = hyperlinks()) {
  return [
    ...(headline ? [`✗ ${headline}`] : []),
    `  Full log: ${link(log.file, supported)}`,
    `  Report it: lunos bug-report ${log.id}`,
  ]
}

let shown = false

/** Print the footer, once, if this run recorded a failure. */
export function footer(write = (text: string) => fs.writeSync(2, text)) {
  const failed = RunLog.failed()
  const log = RunLog.current()
  if (!failed || !log || shown) return false
  shown = true
  try {
    write((fullscreen ? RESTORE : "") + lines(log, failed.headline).join("\n") + "\n")
  } catch {}
  return true
}
