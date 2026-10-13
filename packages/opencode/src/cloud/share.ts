export * as CloudShare from "./share"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { Residency } from "@opencode-ai/core/residency"
import { AuditLog } from "@/audit/log"
import { CloudAuth } from "./auth"
import { ConfigPolicy } from "@/config/policy"
import { CloudOrg } from "./org"
import { Effect } from "effect"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { sanitize } from "@/cli/cmd/export"

/**
 * XCOD-191: uploads to your organisation's Lunos console, and only these: a session or artifact
 * (`lunos share`) and memory facts (`lunos memory share`). Never upstream's share service, and never
 * on their own: each is one explicit command.
 *
 * - **Off by default.** `share` defaults to "disabled". "cloud" allows only these uploads (never
 *   another share service); "manual" and "auto" allow them too. A locked "disabled" is refused and
 *   recorded like any refused override.
 * - **Residency.** Before anything is sent, Lunos asks the console which region it declares
 *   (`GET <console>/v1`) and evaluates the upload as `share:lunos-console` in that region. A console
 *   that declares none is assessed as before: EU only on cloud.lunos.tech, so a self-hosted one
 *   needs `residency.endpoints["share:lunos-console"]` under a policy. Denials are `share.denied`
 *   in the audit log, uploads `share.upload`.
 */

export const TARGET = Jurisdiction.SHARE_LUNOS_CONSOLE

/** A refusal with a message to print as is: sharing is off, or the residency policy denies it. */
export class RefusedError extends Error {
  override name = "CloudShareRefused"
}

type Config = Parameters<typeof AuditLog.residency>[0] & { share?: string; $locked?: string[] }

/** Throws RefusedError unless the `share` setting allows uploads to the organisation's console. */
export function allowed(config: Config, via: string) {
  if (config.share !== "disabled" && config.share !== undefined) return
  if (ConfigPolicy.isLocked(config.$locked, "share")) {
    ConfigPolicy.notifyRefused("share", via)
    throw new RefusedError(`Not shared: ${ConfigPolicy.message("share")} (share is "disabled").`)
  }
  throw new RefusedError(
    `Not shared: sharing is off (share is "disabled", the default). To share with your organisation's Lunos console only, never another service: lunos settings set share cloud`,
  )
}

/**
 * The claim an upload is decided on. The region the console declares at `GET <console>/v1` decides
 * when it declares one, even on cloud.lunos.tech; if `residency.endpoints` also declares
 * `share:lunos-console` and the two disagree, the upload is refused (neither can be verified from
 * here, so a conflict fails closed). With no declared region, the built-in claim (EU only on
 * cloud.lunos.tech) or the `residency.endpoints` declaration decides, as before.
 */
export function claim(config: Config, org: CloudOrg.Org, url: string, region: CloudOrg.Region | undefined) {
  const endpoints = AuditLog.residency(config)?.policy.endpoints
  const resolved = Jurisdiction.resolve(TARGET, url, endpoints).claim
  if (!region) return { claim: resolved }
  const declared = endpoints?.[TARGET]
  const fromConsole: Jurisdiction.Claim = {
    region,
    basis: "declared",
    note: `Declared "${region}" by the console itself (${org.host}, GET /v1). Lunos can't verify it.`,
  }
  if (declared && declared.region !== region)
    return {
      claim: fromConsole,
      conflict: `${org.host} declares its region as "${region}", but residency.endpoints declares "${TARGET}" as "${declared.region}". Correct whichever is wrong.`,
    }
  return { claim: fromConsole }
}

/**
 * The residency decision for an upload to `url`, recorded either way. Throws RefusedError if denied.
 * `region` is what the console declared at `GET <console>/v1` (see `check`).
 */
export function gate(config: Config, org: CloudOrg.Org, url: string, region?: CloudOrg.Region) {
  const residency = AuditLog.residency(config)
  if (!residency) return
  const log = path.join(Global.Path.log, "residency-egress.log")
  const decided = claim(config, org, url, region)
  const decision = Residency.evaluate(TARGET, residency.policy, url, decided.claim)
  const denied = decided.conflict ?? (decision.allowed ? undefined : decision.reason)
  if (denied && residency.enforce !== false) {
    Residency.audit(residency, log, TARGET, url, false, decided.claim)
    throw new RefusedError(`Not shared: uploading to ${org.host} is blocked by the data-residency policy. ${denied}`)
  }
  Residency.audit(residency, log, TARGET, url, true, decided.claim)
}

/**
 * XCOD-191: before every upload, ask the console which region it declares and gate on it. Only when
 * a residency policy or the audit log is on: otherwise nothing would be checked or recorded. If the
 * console can't be asked, an enforcing policy refuses (recorded as share.denied); audit-only goes on.
 */
export async function check(config: Config, org: CloudOrg.Org, url: string, opts: CloudOrg.Options = {}) {
  const residency = AuditLog.residency(config)
  if (!residency) return
  const region = await CloudOrg.region(org, opts).catch((error) => {
    if (error instanceof CloudAuth.SignedOutError) throw error
    if (residency.enforce === false) return undefined
    Residency.audit(residency, path.join(Global.Path.log, "residency-egress.log"), TARGET, url, false)
    throw new RefusedError(
      `Not shared: couldn't ask ${org.host} which region it runs in, so the data-residency policy can't be checked (${error instanceof Error ? error.message : String(error)}).`,
    )
  })
  gate(config, org, url, region)
}

export type ShareInput =
  | { kind: "session"; title: string; content: { info: unknown; messages: unknown[] } }
  | { kind: "artifact"; title: string; content: string }

export interface Shared {
  id: string
  url: string
  sha256: string
  link?: { url: string; expiresAt: string }
}

/**
 * `link`: a number of hours, or `true` for the console's default (30 days, or the organisation's
 * maximum if that is shorter). No hours are sent then, so the console applies its own default and
 * maximum; the expiry it returns is the one shown.
 */
function linkBody(link: number | true | undefined) {
  if (link === undefined) return {}
  return { link: link === true ? {} : { expiresInHours: link } }
}

/**
 * A session as `lunos export` writes it (redacted first with `sanitize`, as `lunos export
 * --sanitize`): what `lunos share <session>` and the TUI's `/share` both upload, so the two can't
 * differ. Fails with Session.NotFound before anything is sent.
 */
export const sessionInput = Effect.fn("CloudShare.sessionInput")(function* (
  sessionID: SessionID,
  opts: { sanitize?: boolean; title?: string } = {},
) {
  const svc = yield* Session.Service
  const info = yield* svc.get(sessionID)
  const messages = yield* svc.messages({ sessionID: info.id })
  const data = { info, messages }
  return {
    kind: "session",
    title: opts.title ?? info.title,
    content: opts.sanitize ? sanitize(data) : data,
  } satisfies ShareInput
})

/** Uploads a session export or an artifact to the organisation's console. */
export async function upload(
  config: Config,
  org: CloudOrg.Org,
  input: ShareInput & { linkHours?: number | true },
  opts: CloudOrg.Options = {},
): Promise<Shared> {
  allowed(config, "lunos share")
  await check(config, org, `${org.base}/shares`, opts)
  const { linkHours, ...body } = input
  const response = await CloudOrg.request(
    org,
    "/shares",
    {
      method: "POST",
      body: JSON.stringify({ ...body, ...linkBody(linkHours) }),
      what: "Sharing",
    },
    { timeoutMs: 60_000, ...opts },
  )
  return (await response.json()) as Shared
}

/** The request body `facts()` sends: `lunos memory share` previews exactly this. */
export function factsBody(list: unknown[]) {
  return JSON.stringify({ facts: list }, null, 2)
}

/** Shares memory facts (lunos-memory/1) with the organisation, for an owner or admin to approve. */
export async function facts(config: Config, org: CloudOrg.Org, list: unknown[], opts: CloudOrg.Options = {}) {
  allowed(config, "lunos memory share")
  await check(config, org, `${org.base}/memory`, opts)
  const response = await CloudOrg.request(
    org,
    "/memory",
    { method: "POST", body: factsBody(list), what: "Sharing memory" },
    opts,
  )
  return (await response.json()) as {
    facts: Array<{ id: string; status: string; duplicate: boolean }>
    message?: string
  }
}

/** One of the organisation's shares, as the console lists them (no content). */
export interface Listed {
  id: string
  kind: "session" | "artifact"
  title: string
  createdBy?: string
  createdAt?: number | string
  revokedAt?: number | string | null
  url?: string
  /** A count (older consoles), or each link with its expiry. */
  links?: number | Array<{ id?: string; expiresAt: number | string; revokedAt?: number | string | null }>
}

/** The organisation's shares (`GET shares`). Nothing is uploaded, so neither `share` nor residency gates it. */
export async function list(org: CloudOrg.Org, opts: CloudOrg.Options = {}) {
  const response = await CloudOrg.request(org, "/shares", { method: "GET", what: "Listing shares" }, opts)
  const body = (await response.json()) as { shares?: Listed[] }
  return body.shares ?? []
}

/** Revokes a share and its links (`DELETE shares/{id}`): its content is deleted on the console. */
export async function revoke(org: CloudOrg.Org, id: string, opts: CloudOrg.Options = {}) {
  await CloudOrg.request(org, `/shares/${encodeURIComponent(id)}`, { method: "DELETE", what: "Revoking a share" }, opts)
}
