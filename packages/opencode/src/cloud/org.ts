export * as CloudOrg from "./org"

import { ConfigManaged } from "@/config/managed"
import { ConfigOrgPolicy } from "@/config/org-policy"
import { CloudAuth } from "./auth"
import { CloudStore } from "./store"

/**
 * XCOD-191: your organisation's Lunos console, for the team features (its private marketplace, team
 * memory and shares). Found the same way as its policy (XCOD-238): `cloud.policy` in managed config,
 * `<console>/v1/orgs/<org>/policy`. Never from user or project config, so a repository can't send
 * your sign-in to its own server, and only to that console, with the `lunos login` session's token.
 */

export const TIMEOUT_MS = 10_000

export interface Org {
  org: string
  /** `<console>/v1/orgs/<org>`: every team API path is under it. */
  base: string
  host: string
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
    return { org: decodeURIComponent(match[2]!), base: `${match[1]}/v1/orgs/${match[2]}`, host: new URL(url).host }
  } catch {
    return
  }
}

/** The organisation this machine's managed config points at, if any. */
export async function resolve(docs?: readonly unknown[]): Promise<Org | undefined> {
  const onDisk = docs ?? (await ConfigManaged.readManagedDocs().catch(() => [] as unknown[]))
  return parse(ConfigOrgPolicy.policyURL(onDisk))
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
  const token = await (opts.token ?? (() => accessToken(init.what)))()
  const { what: _what, ...rest } = init
  const response = await (opts.fetch ?? fetch)(`${org.base}${path}`, {
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
