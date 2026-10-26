export * as MemoryMove from "./move"

import fs from "node:fs"
import { resolveCommand, spawnArgv } from "@/cli/restart"
import { MemorySetupCheck } from "./setup-check"

// XCOD-264: "Move my facts" when switching storage. The facts are exported from the storage in
// use now (in this process, through the existing bundle, XCOD-132), then imported into the new one
// by `lunos memory migrate --from-bundle` in a new process with the new settings layered on top,
// the way the setup check runs. Migrate mode keeps every fact's provenance as the bundle has it.

const TIMEOUT = 11 * 60_000

/**
 * A dev run (`bun run --cwd packages/opencode src/index.ts <project>`) carries `--cwd` in execArgv;
 * passed on, it would start the child in the Lunos checkout, so the facts would land in that
 * repository's namespace instead of the project's. The compiled binary has no execArgv.
 */
export function withoutCwd(execArgv: readonly string[]) {
  const out: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    if (execArgv[i] === "--cwd") {
      i++
      continue
    }
    if (execArgv[i].startsWith("--cwd=")) continue
    out.push(execArgv[i])
  }
  return out
}

export type Result = {
  ok: boolean
  output: string
  facts?: number
  /** Facts the new storage already had (the preview's duplicates): not written again. */
  already?: number
  error?: string
}

export async function run(input: {
  directory: string
  memory: Record<string, unknown>
  to: string
  bundle: string
  env?: Record<string, string>
}): Promise<Result> {
  const command = resolveCommand({
    execPath: process.execPath,
    argv: MemorySetupCheck.entry(process.argv),
    execArgv: withoutCwd(process.execArgv),
    args: ["memory", "migrate", "--to", input.to, "--from-bundle", input.bundle, "--yes"],
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
  const facts = /Moved (\d+) fact/.exec(out)
  const already = /\d+ new, (\d+) duplicate/.exec(out)
  if (code === 0)
    return {
      ok: true,
      output: out.trim(),
      facts: facts ? Number(facts[1]) : undefined,
      ...(already ? { already: Number(already[1]) } : {}),
    }
  const last = (err.trim() || out.trim()).split("\n").filter(Boolean).at(-1)
  return { ok: false, output: out.trim(), error: last ?? `lunos memory migrate exited with ${code}` }
}

/**
 * The count check: every fact exported must have arrived. A move that reports fewer (or none) fails,
 * so nothing is saved and the old storage stays the one in use.
 */
export function counted(result: Result, expected: number): Result {
  if (!result.ok) return result
  const arrived = (result.facts ?? 0) + (result.already ?? 0)
  if (arrived >= expected) return result
  return {
    ...result,
    ok: false,
    error: `Only ${arrived} of ${expected} fact(s) are in the new storage. Nothing was saved; the old storage is still in use`,
  }
}
