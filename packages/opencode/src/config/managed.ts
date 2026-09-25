export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import { Process } from "@/util/process"

// XCOD-102: Lunos-branded locations. The upstream opencode ones are still read, with a
// deprecation warning, but only when no Lunos location exists, so the two never mix.
export const MANAGED_PLIST_DOMAIN = "tech.lunos.managed"
export const LEGACY_PLIST_DOMAIN = "ai.opencode.managed"

// Keys injected by macOS/MDM into the managed plist that are not OpenCode config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

export function systemManagedConfigDir(platform: NodeJS.Platform = process.platform, legacy = false): string {
  switch (platform) {
    case "darwin":
      return legacy ? "/Library/Application Support/opencode" : "/Library/Application Support/Lunos"
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", legacy ? "opencode" : "Lunos")
    default:
      return legacy ? "/etc/opencode" : "/etc/lunos"
  }
}

/** The Lunos location if it exists, else the legacy one if that exists, else the Lunos one. */
export function pickManagedDir(lunos: string, legacy: string, exists: (dir: string) => boolean) {
  if (exists(lunos)) return { dir: lunos, legacy: false }
  if (exists(legacy)) return { dir: legacy, legacy: true }
  return { dir: lunos, legacy: false }
}

export function managedConfigLocation() {
  const hook = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  if (hook) return { dir: hook, legacy: false }
  return pickManagedDir(systemManagedConfigDir(), systemManagedConfigDir(process.platform, true), existsSync)
}

export function managedConfigDir() {
  return managedConfigLocation().dir
}

export function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

export async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch {
      return "user"
    }
  })()
  const paths = (domain: string) => [
    path.join("/Library/Managed Preferences", user, `${domain}.plist`),
    path.join("/Library/Managed Preferences", `${domain}.plist`),
  ]
  const existing = paths(MANAGED_PLIST_DOMAIN).filter(existsSync)
  const legacy = existing.length === 0
  const candidates = legacy ? paths(LEGACY_PLIST_DOMAIN).filter(existsSync) : existing

  for (const plist of candidates) {
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) continue
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
      legacy,
    }
  }

  return
}
