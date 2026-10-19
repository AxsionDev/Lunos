export * as MemorySetupCheck from "./setup-check"

import fs from "node:fs"
import path from "node:path"
import { resolveCommand, spawnArgv } from "@/cli/restart"

// XCOD-249: memory settings apply when Lunos starts, so the setup wizard checks the settings it is
// about to save by running `lunos memory check --json` in a new process with them layered on top
// (`OPENCODE_CONFIG_CONTENT`). The first start installs the engine and downloads the embedding
// model, which the sidecar allows ten minutes for; this waits a little longer than that.

const TIMEOUT = 11 * 60_000

export type Result = { ok: boolean; scope?: string; ms?: number; error?: string; fix?: string }

/**
 * The CLI's own entry script. Inside the TUI the server runs in a worker, whose script is
 * `cli/tui/worker.ts`; started with that, the check would run the worker instead of `lunos`.
 */
export function entry(argv: readonly string[]) {
  const script = argv[1]
  if (!script || !/[\\/]cli[\\/]tui[\\/]worker\.[jt]s$/.test(script)) return argv
  return [argv[0]!, path.resolve(path.dirname(script), "..", "..", "index" + path.extname(script)), ...argv.slice(2)]
}

export async function run(input: {
  directory: string
  memory: Record<string, unknown>
  /** XCOD-264: variables a template's `.env` holds, for the block's `{env:}` references. */
  env?: Record<string, string>
}): Promise<Result> {
  const command = resolveCommand({
    execPath: process.execPath,
    argv: entry(process.argv),
    execArgv: process.execArgv,
    args: ["memory", "check", "--json"],
    upgraded: false,
    platform: process.platform,
    which: (name) => Bun.which(name),
    exists: (file) => fs.existsSync(file),
  })
  const { argv } = spawnArgv(command, process.platform)
  const proc = Bun.spawn(argv, {
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
    return {
      ok: false,
      error:
        code === null || proc.signalCode
          ? "The check took longer than 11 minutes and was stopped"
          : (err.trim().split("\n").at(-1) ?? `The check exited with ${code}`),
    }
  }
}
