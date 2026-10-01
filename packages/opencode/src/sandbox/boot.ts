// XCOD-157: the sandbox's runtime channel, read before anything else. It is the first import of the
// CLI entry point, so the values are in process.env before most modules read it. That alone isn't
// enough: the compiled binary doesn't keep that evaluation order, and Flag had already snapshotted
// OPENCODE_SERVER_PASSWORD and OPENCODE_CONFIG (seen in a real run: `serve` warned the password was
// unset, and the global config never applied). So Flag's snapshot of the keys this file can set is
// refreshed here too, whichever module ran first.
//
// The host creates the container with only LUNOS_SANDBOX_RUNTIME set (a path on a tmpfs), starts it,
// then writes the runtime file through `docker exec`. So provider keys, the server password and the
// user's global config are never in the container's configuration (`docker inspect`), never on the
// sandbox volume, and gone when the container stops: the tmpfs goes with it. `lunos sandbox attach`
// writes them again.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"

export type Runtime = {
  /** Environment for the server: provider keys, OPENCODE_AUTH_CONTENT, OPENCODE_SERVER_PASSWORD. */
  env: Record<string, string>
  /** The user's global config, merged; becomes the server's OPENCODE_CONFIG. */
  config?: Record<string, unknown>
}

export const GLOBAL_CONFIG = "global.json"

/**
 * The keys the runtime can set that Flag reads once, at load, rather than on every access.
 * XCOD-158: the workspace control plane (warp into a docker workspace) sends OPENCODE_WORKSPACE_ID
 * too; without it the server inside didn't know its workspace and refused /sync/steal.
 */
const SNAPSHOTTED = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_WORKSPACE_ID",
] as const

const WAIT_MS = 30_000

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function load(file: string, wait = WAIT_MS) {
  const started = Date.now()
  while (!existsSync(file)) {
    if (Date.now() - started > wait) {
      process.stderr.write(`sandbox: no runtime file at ${file} after ${wait / 1000}s; the host didn't provide it\n`)
      process.exit(1)
    }
    sleep(50)
  }
  const runtime = JSON.parse(readFileSync(file, "utf8")) as Runtime
  // The values now live in this process only; nothing else in the container needs the file.
  rmSync(file, { force: true })
  Object.assign(process.env, runtime.env)
  if (runtime.config && !process.env.OPENCODE_CONFIG) {
    const config = path.join(path.dirname(file), GLOBAL_CONFIG)
    writeFileSync(config, JSON.stringify(runtime.config), { mode: 0o600 })
    process.env.OPENCODE_CONFIG = config
  }
  for (const key of SNAPSHOTTED) Flag[key] = process.env[key]
}

const file = process.env.LUNOS_SANDBOX_RUNTIME
if (file) load(file)
