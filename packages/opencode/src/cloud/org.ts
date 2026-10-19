export * as CloudOrg from "./org"

import { ConfigManaged } from "@/config/managed"
import { ConfigOrgPolicy } from "@/config/org-policy"
import { CloudAuth } from "./auth"
import { CloudStore } from "./store"

/**
 * XCOD-191: your organisation's Lunos console, for the team features (its private marketplace, team
 * memory and shares). Found the same way as its policy (XCOD-238): `cloud.policy` in managed config,
 * `<console>/v1/orgs/<org>/policy`, or (XCOD-242) the hosted organisation remembered at a Lunos
 * sign-in, on a console host built into Lunos. Never from user or project config, so a repository
 * can't send your sign-in to its own server, and only to that console, with the session's token.
 */

export const TIMEOUT_MS = 10_000

export interface Org {
  org: string
  /** `<console>/v1/orgs/<org>`: every team API path is under it. */
  base: string
  host: string
  /** `<console>/v1`: the console's own API root, where it describes itself (its region). */
  api: string
}

/** No `cloud.policy` in managed config: this machine isn't pointed at an organisation's console. */
export class NotConfiguredError extends Error {
  override name = "CloudOrgNotConfigured"
  constructor(what: string) {
    super(
      `${what} needs your organisation's Lunos console, and none is configured here. Your administrator sets "cloud": { "policy": "https://<console>/v1/orgs/<org>/policy" } in managed config.`,
    )
  }
}

/** The console answered with an error: its own message, and the status. */
export class ConsoleError extends Error {
  override name = "CloudOrgConsoleError"
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

/** The organisation from a `cloud.policy` URL, or undefined if it isn't a console's policy URL. */
export function parse(url: string | undefined): Org | undefined {
  if (!url) return
  const match = /^(https?:\/\/[^?#]+)\/v1\/orgs\/([^/?#]+)\/policy$/.exec(url)
  if (!match) return
  try {
    return {
      org: decodeURIComponent(match[2]!),
      base: `${match[1]}/v1/orgs/${match[2]}`,
      host: new URL(url).host,
      api: `${match[1]}/v1`,
    }
  } catch {
    return
  }
}

/**
 * The organisation this machine's managed config (on disk) points at, or the hosted one (XCOD-242).
 * Never from the fetched policy: an organisation's console can't send the token to another host.
 */
export async function resolve(docs?: readonly unknown[]): Promise<Org | undefined> {
  const onDisk = docs ?? (await ConfigManaged.readOnDiskDocs().catch(() => [] as unknown[]))
  return parse(ConfigOrgPolicy.teamSource(onDisk)?.url)
}

/** The session's access token; refreshed (with discovery) only when it is about to expire. */
async function accessToken(what: string) {
  const stored = await CloudStore.load()
  if (!stored) throw new CloudAuth.SignedOutError(what)
  const expires = stored.tokens.expires_at
  if (expires === undefined || expires * 1000 > Date.now() + 30_000) return stored.tokens.access_token
  return (await CloudAuth.session(what)).tokens.access_token
}

export type Options = {
  fetch?: typeof fetch
  token?: () => Promise<string>
  timeoutMs?: number
}

/**
 * A request to `<base><path>` with the session's access token. Throws SignedOutError when nobody is
 * signed in, ConsoleError with the console's own message on an error status. A redirect is refused,
 * so the token can't be carried anywhere else.
 */
export async function request(org: Org, path: string, init: RequestInit & { what: string }, opts: Options = {}) {
  return send(org, `${org.base}${path}`, init, opts)
}

async function send(org: Org, url: string, init: RequestInit & { what: string }, opts: Options) {
  const token = await (opts.token ?? (() => accessToken(init.what)))()
  const { what: _what, ...rest } = init
  const response = await (opts.fetch ?? fetch)(url, {
    ...rest,
    headers: {
      accept: "application/json",
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(rest.headers as Record<string, string> | undefined),
      authorization: `Bearer ${token}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  })
  if (response.ok) return response
  const body = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string } }
    | undefined
  throw new ConsoleError(
    response.status,
    body?.error?.code,
    body?.error?.message ?? `${org.host} answered ${response.status} ${response.statusText}`.trim(),
  )
}

/** A region a console can declare for itself at `GET <console>/v1`. */
export type Region = "eu" | "us" | "other"

/**
 * XCOD-191: the region the console declares at `GET <console>/v1` (`{ api, region, name }`), checked
 * against the residency policy before every upload. Undefined when it doesn't declare one (an older
 * console answers 404, or leaves `region` out): the upload is then assessed as before. Any other
 * failure throws, so a policy can't be passed by a console that can't be asked.
 */
export async function region(org: Org, opts: Options = {}): Promise<Region | undefined> {
  const response = await send(org, org.api, { method: "GET", what: "Checking the console's region" }, opts).catch(
    (error) => {
      if (error instanceof ConsoleError && error.status === 404) return undefined
      throw error
    },
  )
  if (!response) return
  const body = (await response.json().catch(() => undefined)) as { region?: unknown } | undefined
  const value = body?.region
  if (value === undefined || value === null) return
  if (value === "eu" || value === "us" || value === "other") return value
  throw new ConsoleError(
    response.status,
    "bad_region",
    `${org.host} declares a region Lunos doesn't know: ${String(value)}`,
  )
}
