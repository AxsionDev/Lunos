export * as CloudClientStart from "./client-start"

import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Offline } from "@opencode-ai/core/offline"
import { ConfigOrgPolicy } from "@/config/org-policy"
import { ConfigPolicy } from "@/config/policy"
import { CloudOrg } from "./org"

/**
 * XCOD-241: tells the organisation's Lunos console that Lunos started, so it can see which
 * versions run where and which policy they enforce. Contract (docs/deployment/self-hosted.md):
 *
 *   POST <console>/v1/orgs/<org>/clients/start   (the `cloud.policy` URL with `/policy` replaced)
 *   Authorization: Bearer <the lunos login access token>
 *   { install_id, version, os, arch, surface, policy_digest, policy_source }
 *
 * Every key is always present (`policy_digest` may be null). Nothing else: no project names,
 * paths, prompts, code, hostnames or user names. Sent once per process, only right after the
 * console answered the policy fetch at this start (so it is up and accepted the token), never
 * offline, never by `lunos audit`, and not when `cloud.client_start` is false (unless the
 * organisation locks it). Fire and forget: TIMEOUT_MS, no retries, no redirects, failures only at
 * debug level; the CLI waits at most EXIT_WAIT_MS for it before exiting.
 */

export const TIMEOUT_MS = 2000
export const EXIT_WAIT_MS = 1500
const KEY = "cloud.client_start"

export const idFile = () => path.join(Global.Path.data, "cloud", "install-id")

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A random id for this installation, generated the first time it is needed and kept. */
export async function installID(): Promise<string> {
  const file = idFile()
  const read = () => {
    try {
      const value = readFileSync(file, "utf8").trim()
      return UUID.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  const existing = read()
  if (existing) return existing
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const id = randomUUID()
  // `wx` first: a TUI and a `lunos run` starting together agree on one id.
  const created = await fs
    .writeFile(file, id + "\n", { mode: 0o600, flag: "wx" })
    .then(() => true)
    .catch(() => false)
  if (created) return id
  const raced = read()
  if (raced) return raced
  // There was a file, but not an id (edited or truncated): replace it.
  await fs.writeFile(file, id + "\n", { mode: 0o600 })
  return id
}

/** `<console>/v1/orgs/<org>/clients/start`, on the same origin as the policy. */
export function endpoint(policyURL: string | undefined) {
  const org = CloudOrg.parse(policyURL)
  return org ? `${org.base}/clients/start` : undefined
}

/**
 * Whether to send it: a value managed config sets wins; under a lock without a value, the default
 * (on); otherwise the developer's global config; on by default.
 */
export function enabled(input: { managed: unknown; locked: readonly string[]; global: unknown }) {
  const managed = ConfigPolicy.get(input.managed, KEY)
  if (typeof managed === "boolean") return managed
  if (ConfigPolicy.isLocked(input.locked, KEY)) return true
  return ConfigPolicy.get(input.global, KEY) !== false
}

export type Payload = {
  install_id: string
  version: string
  os: string
  arch: string
  surface: ConfigOrgPolicy.Surface
  policy_digest: string | null
  policy_source: string
}

export function payload(
  fields: ReturnType<typeof ConfigOrgPolicy.startFields>,
  installID: string,
  surface: ConfigOrgPolicy.Surface,
): Payload {
  return {
    install_id: installID,
    version: fields.version,
    os: fields.os,
    arch: fields.arch,
    surface,
    policy_digest: fields.policy_digest ?? null,
    policy_source: fields.policy_source,
  }
}

let sent = false
let pending: Promise<void> | undefined

/** Whether `send` still has something to decide in this process. */
export function wanted() {
  return !sent && !!ConfigOrgPolicy.startInfo()
}

export type Options = {
  fetch?: typeof fetch
  token?: () => Promise<string | undefined>
  timeoutMs?: number
}

/**
 * Sends `client.start` once per process, if this start is bound to an organisation and the switch
 * allows it. Never throws and never blocks the caller.
 */
export function send(input: { managed: unknown; locked: readonly string[]; global: unknown }, opts: Options = {}) {
  if (sent) return
  const info = ConfigOrgPolicy.startInfo()
  if (!info) return
  sent = true
  const { result, fields } = info
  if (!ConfigOrgPolicy.announces() || Offline.enabled()) return
  if (result.fetch !== "ok" && result.fetch !== "not_modified") return
  const url = endpoint(result.url)
  if (!url || !enabled(input)) return
  pending = (async () => {
    const token = await (opts.token ?? ConfigOrgPolicy.accessToken)()
    if (!token) return
    const body = payload(fields, await installID(), ConfigOrgPolicy.surface())
    await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    }).then((response) => response.body?.cancel())
  })().catch(() => undefined)
}

/** For the CLI's exit: the request in flight, if any, given at most `ms`. */
export function flush(ms = EXIT_WAIT_MS) {
  if (!pending) return Promise.resolve()
  return Promise.race([pending, Bun.sleep(ms)]).then(() => undefined)
}

/** Tests only. */
export function reset() {
  sent = false
  pending = undefined
}
