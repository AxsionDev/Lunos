export * as CloudHosted from "./hosted"

import { existsSync, readFileSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Offline } from "@opencode-ai/core/offline"
import { CloudDefaults } from "./defaults"
import { CloudOidc } from "./oidc"

/**
 * XCOD-242: hosted Lunos Team without device management. After `lunos login` against Lunos's own
 * sign-in (Keycloak, auth.lunos.tech), Lunos asks Lunos Cloud which hosted organisations the account
 * belongs to and remembers one of them. Team features (the organisation policy, private marketplace,
 * team memory and sharing) then work against that organisation as if managed config set
 * `cloud.policy` to `https://cloud.lunos.tech/v1/orgs/<org>/policy`.
 *
 * - The console host is compiled in (HOSTS): never taken from config, the token, the account
 *   response or the file below. Only the organisation's id is remembered, checked against the
 *   console's own id rule before it goes into a URL.
 * - Only a sign-in to Lunos's own issuer turns it on. Any other issuer clears it.
 * - Managed `cloud.policy` always wins, and managed `cloud.auto_team: false` turns it off
 *   (`ConfigOrgPolicy.teamSource`).
 * - The lookup happens once, at `lunos login`; starting Lunos makes no new call for it. Joining an
 *   organisation later needs another `lunos login`. `lunos logout` forgets it.
 */

/** The Lunos-operated consoles team features may be turned on for without managed config. */
export const HOSTS: readonly string[] = ["cloud.lunos.tech"]

/** The console's organisation id rule (lunoshq console/src/members.ts ORG_ID). */
const ORG_ID = /^[a-z0-9][a-z0-9-]{1,62}$/

export const file = () => path.join(Global.Path.data, "cloud", "hosted-team.json")

export type Remembered = { issuer: string; sub: string; org: string; savedAt: string }

const trimmed = (url: string) => url.replace(/\/+$/, "")

/** Whether a sign-in to `issuer` is Lunos's own: the only one that turns hosted team features on. */
export function lunosIssuer(issuer: string) {
  return trimmed(issuer) === trimmed(CloudDefaults.DEFAULT_ISSUER)
}

let host = HOSTS[0]!

/** Tests only: serve the built-in console from a local fake. Returns the function that restores it. */
export function useHostForTests(origin: string) {
  const previous = host
  host = origin
  return () => {
    host = previous
  }
}

function origin() {
  return host.includes("://") ? host : `https://${host}`
}

/** The remembered organisation, if the file is intact and was saved for Lunos's sign-in. */
export function remembered(): Remembered | undefined {
  const where = file()
  if (!existsSync(where)) return
  try {
    const value = JSON.parse(readFileSync(where, "utf8")) as Partial<Remembered>
    if (typeof value.org !== "string" || !ORG_ID.test(value.org)) return
    if (typeof value.issuer !== "string" || !lunosIssuer(value.issuer)) return
    if (typeof value.sub !== "string" || !value.sub) return
    return value as Remembered
  } catch {
    return
  }
}

/** `<built-in console>/v1/orgs/<org>/policy` for the remembered organisation, if any. No network. */
export function policyURL(): string | undefined {
  const org = remembered()?.org
  if (!org) return
  return `${origin()}/v1/orgs/${org}/policy`
}

export async function clear() {
  await fs.rm(file(), { force: true })
}

async function save(value: Remembered) {
  const where = file()
  await fs.mkdir(path.dirname(where), { recursive: true, mode: 0o700 })
  const tmp = `${where}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(tmp, where)
}

/** The organisations an access token's `organization` claim names (a string, a list or an object). */
function claimed(token: string): string[] {
  const claims = CloudOidc.claims(token)
  const value = claims.organization ?? claims.organizations
  if (Array.isArray(value)) return value.map(String)
  if (value && typeof value === "object") return Object.keys(value)
  if (typeof value === "string") return [value]
  return []
}

/**
 * Which organisation to use: the one the token's organisation claim names, if the account is a
 * member of exactly one such; else the account's only organisation. The claim only chooses among the
 * account's own memberships (the console's database decides those), never a host.
 */
export function choose(memberships: readonly string[], token: string): string | undefined {
  const valid = memberships.filter((org) => ORG_ID.test(org))
  const named = claimed(token).filter((org) => valid.includes(org))
  if (named.length === 1) return named[0]
  if (valid.length === 1) return valid[0]
}

export type Outcome =
  | { kind: "off"; reason: "issuer" | "offline" }
  | { kind: "none" }
  | { kind: "several"; orgs: string[] }
  | { kind: "on"; org: string }
  | { kind: "failed"; message: string }

export type Options = { fetch?: typeof fetch; timeoutMs?: number }

/**
 * `lunos login`'s part: ask the built-in console which organisations the account belongs to
 * (`GET /v1/account`) and remember one. Clears what was remembered first, so a failed lookup or a
 * sign-in elsewhere never leaves an old organisation behind.
 */
export async function afterLogin(
  session: { issuer: string; sub: string; tokens: { access_token: string } },
  opts: Options = {},
): Promise<Outcome> {
  await clear()
  if (!lunosIssuer(session.issuer)) return { kind: "off", reason: "issuer" }
  if (Offline.enabled()) return { kind: "off", reason: "offline" }
  const token = session.tokens.access_token
  let body: { organizations?: unknown } | undefined
  try {
    const response = await (opts.fetch ?? fetch)(`${origin()}/v1/account`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      // A redirect must not carry the token somewhere else.
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    })
    if (!response.ok) return { kind: "failed", message: `${new URL(origin()).host} answered ${response.status}` }
    body = (await response.json().catch(() => undefined)) as typeof body
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
  }
  const memberships = Array.isArray(body?.organizations)
    ? body.organizations
        .map((item) => (item && typeof item === "object" ? (item as { org?: unknown }).org : undefined))
        .filter((org): org is string => typeof org === "string")
    : []
  if (!memberships.length) return { kind: "none" }
  const org = choose(memberships, token)
  if (!org) return { kind: "several", orgs: memberships }
  await save({ issuer: session.issuer, sub: session.sub, org, savedAt: new Date().toISOString() })
  return { kind: "on", org }
}

/** What `lunos login` prints about it. Undefined when there's nothing to say (another issuer). */
export function describe(outcome: Outcome): string | undefined {
  switch (outcome.kind) {
    case "on":
      return `Team features: on for ${outcome.org} (hosted on ${new URL(origin()).host}).`
    case "several":
      return `Team features: off. You're a member of several organisations on ${new URL(origin()).host} (${outcome.orgs.join(", ")}) and your sign-in doesn't name one; ask your administrator to set cloud.policy in managed config.`
    case "failed":
      return `Team features: couldn't check your organisations (${outcome.message}). Run lunos login again to retry.`
    case "none":
    case "off":
      return
  }
}
