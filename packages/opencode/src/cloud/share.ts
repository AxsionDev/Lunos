export * as CloudShare from "./share"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { Residency } from "@opencode-ai/core/residency"
import { AuditLog } from "@/audit/log"
import { ConfigPolicy } from "@/config/policy"
import { CloudOrg } from "./org"

/**
 * XCOD-191: uploads to your organisation's Lunos console, and only these: a session or artifact
 * (`lunos share`) and memory facts (`lunos memory share`). Never upstream's share service, and never
 * on their own: each is one explicit command.
 *
 * - **Off by default.** `share` defaults to "disabled". "cloud" allows only these uploads (never
 *   another share service); "manual" and "auto" allow them too. A locked "disabled" is refused and
 *   recorded like any refused override.
 * - **Residency.** Each upload is evaluated as `share:lunos-console` at the console's host before
 *   anything is sent: an EU claim only on cloud.lunos.tech, so a self-hosted console needs
 *   `residency.endpoints["share:lunos-console"]` under a policy. Denials are `share.denied` in the
 *   audit log, uploads `share.upload`.
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

/** The residency decision for an upload to `url`, recorded either way. Throws RefusedError if denied. */
export function gate(config: Config, org: CloudOrg.Org, url: string) {
  const residency = AuditLog.residency(config)
  if (!residency) return
  const log = path.join(Global.Path.log, "residency-egress.log")
  try {
    Residency.enforce({
      providerID: TARGET,
      baseURL: url,
      resolved: residency,
      defaultAuditPath: log,
      fetch: undefined,
    })
  } catch (error) {
    if (error instanceof Residency.DeniedError)
      throw new RefusedError(
        `Not shared: uploading to ${org.host} is blocked by the data-residency policy. ${error.decision.reason}`,
      )
    throw error
  }
  Residency.audit(residency, log, TARGET, url, true)
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

/** Uploads a session export or an artifact to the organisation's console. */
export async function upload(
  config: Config,
  org: CloudOrg.Org,
  input: ShareInput & { linkHours?: number },
  opts: CloudOrg.Options = {},
): Promise<Shared> {
  allowed(config, "lunos share")
  gate(config, org, `${org.base}/shares`)
  const { linkHours, ...body } = input
  const response = await CloudOrg.request(
    org,
    "/shares",
    {
      method: "POST",
      body: JSON.stringify({ ...body, ...(linkHours !== undefined ? { link: { expiresInHours: linkHours } } : {}) }),
      what: "Sharing",
    },
    { timeoutMs: 60_000, ...opts },
  )
  return (await response.json()) as Shared
}

/** Shares memory facts (lunos-memory/1) with the organisation, for an owner or admin to approve. */
export async function facts(config: Config, org: CloudOrg.Org, list: unknown[], opts: CloudOrg.Options = {}) {
  allowed(config, "lunos memory share")
  gate(config, org, `${org.base}/memory`)
  const response = await CloudOrg.request(
    org,
    "/memory",
    { method: "POST", body: JSON.stringify({ facts: list }), what: "Sharing memory" },
    opts,
  )
  return (await response.json()) as {
    facts: Array<{ id: string; status: string; duplicate: boolean }>
    message?: string
  }
}
