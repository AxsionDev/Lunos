export * as MemorySetupCheck from "./setup-check"

import fs from "node:fs"
import path from "node:path"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { resolveCommand, spawnArgv } from "@/cli/restart"
import { MemoryFailure } from "./failure"
import { withoutCwd } from "./move"

// XCOD-249: memory settings apply when Lunos starts, so the setup wizard checks the settings it is
// about to save by running `lunos memory check --json` in a new process with them layered on top
// (`OPENCODE_CONFIG_CONTENT`). The first start installs the engine and downloads the embedding
// model, which the sidecar allows ten minutes for; this waits a little longer than that.

const TIMEOUT = 11 * 60_000

export type Result = {
  ok: boolean
  scope?: string
  ms?: number
  error?: string
  fix?: string
  // XCOD-263: why it failed (see `CheckFailure` in cli/cmd/memory-setup.ts).
  stage?: string | null
  type?: string | null
  cause?: string | null
  model?: string | null
  log?: string | null
  sampling?: { provider: string; model: string; message: string }[]
  diagnostics?: string
}

/**
 * The CLI's own entry script. Inside the TUI the server runs in a worker, whose script is
 * `cli/tui/worker.ts`; started with that, the check would run the worker instead of `lunos`.
 */
export function entry(argv: readonly string[]) {
  const script = argv[1]
  if (!script || !/[\\/]cli[\\/]tui[\\/]worker\.[jt]s$/.test(script)) return argv
  return [argv[0]!, path.resolve(path.dirname(script), "..", "..", "index" + path.extname(script)), ...argv.slice(2)]
}

/**
 * The command the check runs. A dev run's `--cwd` is dropped (see `withoutCwd`), so the check runs in
 * the project it is given rather than in the Lunos checkout, and remembers its test fact there.
 */
export function argv(input: { execPath: string; argv: readonly string[]; execArgv: readonly string[] }) {
  const command = resolveCommand({
    execPath: input.execPath,
    argv: entry(input.argv),
    execArgv: withoutCwd(input.execArgv),
    args: ["memory", "check", "--json"],
    upgraded: false,
    platform: process.platform,
    which: (name) => Bun.which(name),
    exists: (file) => fs.existsSync(file),
  })
  return spawnArgv(command, process.platform).argv
}

export async function run(input: {
  directory: string
  memory: Record<string, unknown>
  /** XCOD-264: variables a template's `.env` holds, for the block's `{env:}` references. */
  env?: Record<string, string>
}): Promise<Result> {
  const proc = Bun.spawn(argv({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv }), {
    cwd: input.directory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...input.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ memory: input.memory }) },
  })
  const timer = setTimeout(() => proc.kill(), TIMEOUT)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  const line = out.trim().split("\n").at(-1) ?? ""
  try {
    return JSON.parse(line) as Result
  } catch {
    return unparsed({ code, signal: proc.signalCode, stderr: err })
  }
}

/**
 * The check printed no result: it crashed, or was stopped. The last stderr line is the error and the
 * lines before it the cause, so nothing it said is dropped; with no stderr, the exit code says it.
 */
export function unparsed(input: { code: number | null; signal?: string | number | null; stderr: string }): Result {
  const lines = input.stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
  const timedOut = input.code === null || !!input.signal
  const error = timedOut
    ? "The check took longer than 11 minutes and was stopped"
    : (lines.at(-1)?.trim() ?? "") || `The check exited with code ${input.code} and printed nothing`
  const type = timedOut ? "TimeoutError" : "CheckCrashed"
  const cause = lines.slice(-20, -1)
  return {
    ok: false,
    error,
    stage: "check",
    type,
    cause: cause.length ? cause.join("\n") : null,
    model: null,
    log: null,
    diagnostics: MemoryFailure.diagnostics({
      error,
      info: { type, message: error, cause: cause.slice(-5), stage: "check", sampling: [] },
      version: InstallationVersion,
    }),
  }
}
