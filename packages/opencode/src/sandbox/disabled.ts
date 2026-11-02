export * as SandboxDisabled from "./disabled"

import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import type { SandboxFailure } from "@opencode-ai/tui/util/sandbox"
import { SandboxConfig } from "./config"

// XCOD-281: `sandbox_auto_disabled`. When the sandbox fails to start, Lunos turns it off for this
// computer and project, here in local state, and never by rewriting a config file (those can be
// shared in the repository). It carries a hash of the effective sandbox config: change the config
// and the entry no longer applies. sandbox.required ignores it (see `wanted`).

export type Entry = SandboxFailure & {
  /** The effective sandbox config when it failed (`hash`). */
  config: string
}

export const file = (state = Global.Path.state) => path.join(state, "sandbox-auto-disabled.json")

/** The effective sandbox config, hashed: a change to any sandbox setting clears the entry. */
export function hash(config: SandboxConfig.Resolved) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16)
}

const key = (directory: string) => path.resolve(directory)

function read(): Record<string, Entry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function write(all: Record<string, Entry>) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 })
}

/** The entry for `directory`, unless the sandbox config has changed since (then it's removed). */
export function get(directory: string, config = SandboxConfig.load(directory)): Entry | undefined {
  const all = read()
  const entry = all[key(directory)]
  if (!entry) return undefined
  if (entry.config === hash(config)) return entry
  delete all[key(directory)]
  write(all)
  return undefined
}

export function set(directory: string, failure: SandboxFailure, config = SandboxConfig.load(directory)): Entry {
  const all = read()
  const entry = { ...failure, config: hash(config) }
  all[key(directory)] = entry
  write(all)
  return entry
}

export function clear(directory: string) {
  const all = read()
  if (!all[key(directory)]) return false
  delete all[key(directory)]
  write(all)
  return true
}
