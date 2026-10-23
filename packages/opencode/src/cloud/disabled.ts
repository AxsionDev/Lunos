export * as CloudDisabled from "./disabled"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import {
  DISABLED_CATEGORY_TEXT,
  DISABLED_TITLE,
  disabledLines,
  type Disabled,
  type DisabledCategory,
} from "@opencode-ai/tui/util/account"
import { ConfigManaged } from "@/config/managed"
import { SandboxConfig } from "@/sandbox/config"
import { CloudGate } from "./gate"

/**
 * XCOD-312: a disabled Lunos account. Lunos Cloud answers any call for it 403 `suspended` with
 * `details: { scope: "account", category?, until? }`; the sign-in service (Keycloak) disables the user
 * and ends its sessions, so a refresh fails `invalid_grant`. This machine keeps what it was told (the
 * category and the end date, never the free-text reason) until a new sign-in, a sign-out, or a
 * refresh that Lunos Cloud then answers, so a restart still shows the screen and the session loop
 * still refuses new prompts.
 *
 * Nothing here imports the account API, the sign-in or the token store: they all record through it.
 */

export type { Disabled }

export const file = () => path.join(Global.Path.data, "cloud", "disabled.json")

const CATEGORIES = Object.keys(DISABLED_CATEGORY_TEXT) as DisabledCategory[]

/**
 * Whether a refusal is the account's own suspension, and what it says. An organisation's (`scope:
 * "org"`) isn't; neither is a `suspended` that names no scope, unless its code is `account_suspended`
 * (an older server's, or the nested legacy code). An unknown category is left out; an `until` that
 * isn't a date is too.
 */
export function suspension(
  status: number,
  found: { code?: string; legacyCode?: string; details?: Record<string, unknown> },
): Disabled | undefined {
  if (status !== 403) return
  const codes = [found.code, found.legacyCode]
  if (!codes.some((code) => code === "suspended" || code === "account_suspended")) return
  const scope = found.details?.scope
  if (scope !== "account" && !(scope === undefined && codes.includes("account_suspended"))) return
  const category = CATEGORIES.find((item) => item === found.details?.category)
  const until = typeof found.details?.until === "string" ? found.details.until : undefined
  const valid = until !== undefined && !Number.isNaN(Date.parse(until))
  return { ...(category ? { category } : {}), ...(valid ? { until: new Date(until).toISOString() } : {}) }
}

/** A refused refresh whose `error_description` says the user is disabled ("Account disabled", "User disabled"). */
export function refreshSaysDisabled(error: { code?: string; description?: string }) {
  return error.code === "invalid_grant" && /disabled/i.test(error.description ?? "")
}

export async function record(disabled: Disabled) {
  await fs.mkdir(path.dirname(file()), { recursive: true, mode: 0o700 })
  await fs.writeFile(file(), JSON.stringify({ ...disabled, at: new Date().toISOString() }), { mode: 0o600 })
}

export async function load(): Promise<Disabled | undefined> {
  const raw = await fs.readFile(file(), "utf8").catch(() => undefined)
  if (!raw) return undefined
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>
    return suspension(403, { code: "suspended", details: { ...stored, scope: "account" } })
  } catch {
    // Unreadable: still disabled, only without the details.
    return {}
  }
}

export async function clear() {
  await fs.rm(file(), { force: true })
}

/** "Your Lunos account is disabled. Reason: …. Contact support: support@lunos.tech." */
export const text = (disabled: Disabled) => `${[DISABLED_TITLE, ...disabledLines(disabled)].join(". ")}.`

/** Thrown where a call found the account disabled (and recorded it). */
export class DisabledError extends Error {
  override name = "CloudAccountDisabled"
  constructor(readonly disabled: Disabled) {
    super(text(disabled))
  }
}

/**
 * The reason the session loop refuses a new prompt, or undefined. Only where this start needs a Lunos
 * account at all (CloudGate): self-hosted, an organisation's issuer, offline, CI and a build from
 * source never do, so a record left behind doesn't stop them. The terminal isn't asked (the loop may
 * run without one); the TUI's own Welcome screen decides that part.
 */
export async function refusal(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const disabled = await load()
  if (!disabled) return undefined
  const managed = await ConfigManaged.readOnDiskDocs().catch(() => [] as unknown[])
  const gate = CloudGate.resolve({
    managed,
    global: SandboxConfig.globalDoc(),
    env,
    tty: { stdin: true, stdout: true },
  })
  if (!gate.required) return undefined
  return `${DISABLED_TITLE}, so new prompts can't run. ${disabledLines(disabled).join(". ")}.`
}
