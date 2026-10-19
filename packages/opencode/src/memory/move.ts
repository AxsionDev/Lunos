export * as MemoryMove from "./move"

import fs from "node:fs"
import { resolveCommand, spawnArgv } from "@/cli/restart"
import { MemorySetupCheck } from "./setup-check"

// XCOD-264: "Move my facts" when switching storage. The facts are exported from the storage in
// use now (in this process, through the existing bundle, XCOD-132), then imported into the new one
// by `lunos memory migrate --from-bundle` in a new process with the new settings layered on top,
// the way the setup check runs. Migrate mode keeps every fact's provenance as the bundle has it.

const TIMEOUT = 11 * 60_000

export type Result = { ok: boolean; output: string; facts?: number; error?: string }

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
    execArgv: process.execArgv,
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
  if (code === 0) return { ok: true, output: out.trim(), facts: facts ? Number(facts[1]) : undefined }
  const last = (err.trim() || out.trim()).split("\n").filter(Boolean).at(-1)
  return { ok: false, output: out.trim(), error: last ?? `lunos memory migrate exited with ${code}` }
}
