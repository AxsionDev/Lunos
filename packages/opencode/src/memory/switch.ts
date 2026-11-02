export * as MemorySwitch from "./switch"

import type { ConfigMemory } from "@opencode-ai/core/config/memory"

/**
 * Whether memory is on, and which switch decided (XCOD-94). Checked before anything memory-related
 * happens: when this says off, no sidecar is started, no memory directory is created, no memory
 * tool is offered and no model call is made for memory.
 *
 * Order, strongest first:
 * 1. `LUNOS_DISABLE_MEMORY` set to anything but "" / "0" / "false": off.
 * 2. `/memory off` in this session: off for the session.
 * 3. `memory.enabled` in config. Absent means off: memory is opt-in.
 */

export const ENV = "LUNOS_DISABLE_MEMORY"

export type Decision = { on: true } | { on: false; by: "env" | "session" | "config"; reason: string }

export function envDisables(env: Record<string, string | undefined>) {
  const value = env[ENV]?.trim().toLowerCase()
  return value !== undefined && value !== "" && value !== "0" && value !== "false"
}

export function decide(input: {
  config: ConfigMemory.Info | undefined
  env: Record<string, string | undefined>
  sessionOff?: boolean
}): Decision {
  if (envDisables(input.env)) return { on: false, by: "env", reason: `${ENV} is set` }
  if (input.sessionOff) return { on: false, by: "session", reason: "turned off with /memory off in this session" }
  if (input.config?.enabled !== true)
    return { on: false, by: "config", reason: 'memory is off; set "memory": { "enabled": true } to turn it on' }
  return { on: true }
}
