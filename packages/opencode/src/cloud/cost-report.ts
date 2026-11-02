export * as CloudCostReport from "./cost-report"

import { createHash } from "crypto"
import { Offline } from "@opencode-ai/core/offline"
import { ConfigOrgPolicy } from "@/config/org-policy"
import { ConfigPolicy } from "@/config/policy"
import { CloudClientStart } from "./client-start"
import { CloudOrg } from "./org"

/**
 * XCOD-298: a cost report to the organisation's Lunos console after each model step, so the console
 * can add up an organisation project's spend across its members. Contract:
 *
 *   POST <console>/v1/orgs/<org>/usage/turns   (the `cloud.policy` URL with `/policy` replaced)
 *   Authorization: Bearer <the lunos login access token>
 *   { install_id, time, amount_usd, unknown_cost, model, project_id }
 *
 * `project_id` is opaque: a named project's random `pgrp_…` id as it is, any other project's id
 * (a repository's, or a plain folder's, which holds its path) as a SHA-256, so no path or commit
 * leaves the computer and members' copies of one repository still add up. `model` is `provider/model`. Nothing else: no prompt, code, output, file, path, title or user
 * name. **Off by default.** It's on only when `cloud.cost_report` is true in managed or user config
 * (never a project's), this start is bound to an organisation (`cloud.policy`; never for a personal
 * account), the console answered the policy fetch, and Lunos isn't offline. Fire and forget, like
 * `client.start`: TIMEOUT_MS, no retries, no redirects, failures ignored.
 *
 * Turning it on for an organisation needs the Team terms and privacy notice to cover it (XCOD-226).
 */

export const TIMEOUT_MS = 2000
const KEY = "cloud.cost_report"

let settings: { managed: unknown; locked: readonly string[]; global: unknown } | undefined

/** From the config load, as `client.start` gets it: managed and global config, never a project's. */
export function configure(input: { managed: unknown; locked: readonly string[]; global: unknown }) {
  settings = input
}

/** Managed config's value wins; otherwise the user's global config; off by default. */
export function enabled(input: { managed: unknown; locked: readonly string[]; global: unknown }) {
  const managed = ConfigPolicy.get(input.managed, KEY)
  if (typeof managed === "boolean") return managed
  if (ConfigPolicy.isLocked(input.locked, KEY)) return false
  return ConfigPolicy.get(input.global, KEY) === true
}

export function endpoint(policyURL: string | undefined) {
  const org = CloudOrg.parse(policyURL)
  return org ? `${org.base}/usage/turns` : undefined
}

export type Turn = { cost: number; model: string; project: string }

/** The project id as reported: a `pgrp_…` id as it is, anything else hashed. */
export function projectID(id: string) {
  if (/^pgrp_[0-9a-f]+$/.test(id)) return id
  return "sha256:" + createHash("sha256").update(id).digest("hex").slice(0, 32)
}

/** Whether reports go out at all in this process (so the budget guard can skip its lookups). */
export function active() {
  return !!settings && enabled(settings)
}

export type Payload = {
  install_id: string
  time: string
  amount_usd: number
  unknown_cost: boolean
  model: string
  project_id: string
}

export function payload(turn: Turn, installID: string, now = Date.now()): Payload {
  return {
    install_id: installID,
    time: new Date(now).toISOString(),
    amount_usd: Math.max(0, turn.cost),
    unknown_cost: !(turn.cost > 0),
    model: turn.model,
    project_id: projectID(turn.project),
  }
}

export type Options = {
  fetch?: typeof fetch
  token?: () => Promise<string | undefined>
  timeoutMs?: number
}

const inflight = new Set<Promise<void>>()

/** Sends one step's report, if everything above allows it. Never throws or blocks. */
export function send(turn: Turn, opts: Options = {}) {
  if (!settings || !enabled(settings) || Offline.enabled()) return
  const info = ConfigOrgPolicy.startInfo()
  if (!info || (info.result.fetch !== "ok" && info.result.fetch !== "not_modified")) return
  const url = endpoint(info.result.url)
  if (!url) return
  const request = (async () => {
    const token = await (opts.token ?? ConfigOrgPolicy.accessToken)()
    if (!token) return
    await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload(turn, await CloudClientStart.installID())),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    }).then((response) => response.body?.cancel())
  })().catch(() => undefined)
  inflight.add(request)
  void request.finally(() => inflight.delete(request))
}

/** For the CLI's exit: the reports in flight, given at most `ms`. */
export function flush(ms = 1500) {
  if (!inflight.size) return Promise.resolve()
  return Promise.race([Promise.all(inflight), Bun.sleep(ms)]).then(() => undefined)
}

/** Tests only. */
export function reset() {
  settings = undefined
  inflight.clear()
}
