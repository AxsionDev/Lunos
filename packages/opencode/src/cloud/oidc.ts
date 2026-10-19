export * as CloudOidc from "./oidc"

/**
 * XCOD-185: signing in to Lunos Cloud from the CLI with the OAuth 2.0 device authorization grant
 * (RFC 8628) against a standard OpenID Connect provider. Lunos Cloud's identity provider runs in
 * the Phase 7 data centre; until it exists, `cloud.issuer` points at any OIDC provider an
 * organisation runs (Keycloak, Zitadel, Authentik…). Nothing here is Lunos-specific on the wire.
 */

export interface Discovery {
  issuer: string
  device_authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  revocation_endpoint?: string
}

export interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

export interface Tokens {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type: string
  /** Seconds since the epoch. */
  expires_at?: number
  scope?: string
}

export interface User {
  sub: string
  email?: string
  name?: string
  preferred_username?: string
  /** Organisations the provider puts in the token (Keycloak `organization`, Zitadel roles…). */
  organizations?: string[]
}

export class OidcError extends Error {
  override name = "CloudOidcError"
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

type Fetch = typeof fetch

function trimmed(issuer: string) {
  return issuer.replace(/\/+$/, "")
}

export async function discover(issuer: string, fetcher: Fetch = fetch): Promise<Discovery> {
  const url = `${trimmed(issuer)}/.well-known/openid-configuration`
  const response = await fetcher(url, { headers: { accept: "application/json" } }).catch((error: unknown) => {
    throw new OidcError(`Couldn't reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!response.ok) throw new OidcError(`${url} answered ${response.status}; is ${issuer} an OpenID Connect issuer?`)
  const doc = (await response.json()) as Partial<Discovery>
  if (!doc.device_authorization_endpoint || !doc.token_endpoint)
    throw new OidcError(
      `${issuer} doesn't offer device sign-in (no device_authorization_endpoint). Enable the OAuth 2.0 device authorization grant for the Lunos client.`,
    )
  // The discovery document must be about the issuer we asked for (OIDC Discovery §4.3).
  if (doc.issuer && trimmed(doc.issuer) !== trimmed(issuer))
    throw new OidcError(`${url} describes issuer ${doc.issuer}, not ${issuer}`)
  return doc as Discovery
}

const form = (values: Record<string, string>) => new URLSearchParams(values)

async function post(url: string, body: URLSearchParams, fetcher: Fetch) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: response.ok, status: response.status, json }
}

export async function startDevice(
  discovery: Discovery,
  clientID: string,
  scope = "openid profile email offline_access",
  fetcher: Fetch = fetch,
): Promise<DeviceCode> {
  const result = await post(discovery.device_authorization_endpoint, form({ client_id: clientID, scope }), fetcher)
  if (!result.ok)
    throw new OidcError(
      `Device sign-in was refused: ${String(result.json.error_description ?? result.json.error ?? result.status)}`,
      String(result.json.error ?? ""),
    )
  return result.json as unknown as DeviceCode
}

function toTokens(json: Record<string, unknown>, now = Date.now()): Tokens {
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    id_token: json.id_token ? String(json.id_token) : undefined,
    token_type: String(json.token_type ?? "Bearer"),
    expires_at: typeof json.expires_in === "number" ? Math.floor(now / 1000) + json.expires_in : undefined,
    scope: json.scope ? String(json.scope) : undefined,
  }
}

export type PollResult =
  | { status: "ok"; tokens: Tokens }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }

/** One poll of the token endpoint (RFC 8628 §3.4–3.5). */
export async function pollOnce(
  discovery: Discovery,
  clientID: string,
  device: DeviceCode,
  fetcher: Fetch = fetch,
): Promise<PollResult> {
  const result = await post(
    discovery.token_endpoint,
    form({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: clientID,
    }),
    fetcher,
  )
  if (result.ok && result.json.access_token) return { status: "ok", tokens: toTokens(result.json) }
  switch (result.json.error) {
    case "authorization_pending":
      return { status: "pending" }
    case "slow_down":
      return { status: "slow_down" }
    case "access_denied":
      return { status: "denied" }
    case "expired_token":
      return { status: "expired" }
  }
  throw new OidcError(
    `Sign-in failed: ${String(result.json.error_description ?? result.json.error ?? result.status)}`,
    String(result.json.error ?? ""),
  )
}

/** Polls until the user approves, denies or the code expires. `sleep` is injectable for tests. */
export async function waitForTokens(
  discovery: Discovery,
  clientID: string,
  device: DeviceCode,
  options: { fetcher?: Fetch; sleep?: (ms: number) => Promise<unknown>; signal?: AbortSignal } = {},
): Promise<Tokens> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let interval = Math.max(1, device.interval ?? 5)
  const deadline = Date.now() + device.expires_in * 1000
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new OidcError("Sign-in cancelled", "cancelled")
    await sleep(interval * 1000)
    const result = await pollOnce(discovery, clientID, device, options.fetcher)
    if (result.status === "ok") return result.tokens
    if (result.status === "slow_down") interval += 5
    if (result.status === "denied") throw new OidcError("Sign-in was denied in the browser", "access_denied")
    if (result.status === "expired") break
  }
  throw new OidcError("The sign-in code expired before it was approved. Run lunos login again.", "expired_token")
}

export async function refresh(
  discovery: Discovery,
  clientID: string,
  tokens: Tokens,
  fetcher: Fetch = fetch,
): Promise<Tokens> {
  if (!tokens.refresh_token) throw new OidcError("The session has expired; run lunos login again", "no_refresh")
  const result = await post(
    discovery.token_endpoint,
    form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientID }),
    fetcher,
  )
  if (!result.ok || !result.json.access_token)
    throw new OidcError(
      "The session has expired or was revoked; run lunos login again",
      String(result.json.error ?? ""),
    )
  const next = toTokens(result.json)
  return { ...next, refresh_token: next.refresh_token ?? tokens.refresh_token }
}

/** The claims of a JWT's payload, without checking its signature (display only, never trust). */
export function claims(jwt: string | undefined): Record<string, unknown> {
  const part = jwt?.split(".")[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
  } catch {
    return {}
  }
}

function organizations(source: Record<string, unknown>): string[] | undefined {
  const value = source.organization ?? source.organizations
  if (Array.isArray(value)) return value.map(String)
  if (value && typeof value === "object") return Object.keys(value)
  if (typeof value === "string") return [value]
  return undefined
}

/** Who is signed in: the userinfo endpoint (verified by the provider), else the ID token's claims. */
export async function user(discovery: Discovery, tokens: Tokens, fetcher: Fetch = fetch): Promise<User> {
  const fromToken = claims(tokens.id_token)
  let info: Record<string, unknown> = {}
  if (discovery.userinfo_endpoint) {
    const response = await fetcher(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" },
    })
    if (response.status === 401) throw new OidcError("The session has expired or was revoked", "unauthorized")
    if (response.ok) info = (await response.json()) as Record<string, unknown>
  }
  const merged = { ...fromToken, ...info }
  if (!merged.sub) throw new OidcError("The identity provider didn't say who you are (no sub claim)")
  return {
    sub: String(merged.sub),
    email: merged.email ? String(merged.email) : undefined,
    name: merged.name ? String(merged.name) : undefined,
    preferred_username: merged.preferred_username ? String(merged.preferred_username) : undefined,
    organizations: organizations(merged) ?? organizations(claims(tokens.access_token)),
  }
}

/** Revokes the refresh token (RFC 7009) so it stops working everywhere, if the provider supports it. */
export async function revoke(discovery: Discovery, clientID: string, tokens: Tokens, fetcher: Fetch = fetch) {
  if (!discovery.revocation_endpoint || !tokens.refresh_token) return false
  const result = await post(
    discovery.revocation_endpoint,
    form({ token: tokens.refresh_token, token_type_hint: "refresh_token", client_id: clientID }),
    fetcher,
  )
  return result.ok
}
