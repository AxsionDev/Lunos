export * as CloudAccountApi from "./account-api"

import { Offline } from "@opencode-ai/core/offline"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-273/274: the account and organisation calls /account, the sign-in screen and `lunos org` make
 * to Lunos Cloud's control plane (lunoshq), with the session's own token. Only for a sign-in Lunos
 * Cloud may receive (`CloudSyncApi.permitted`: Lunos's own issuer, or a configured `cloud.endpoint`),
 * never offline. Every permission is decided there; this side only shows the answer.
 *
 * The account (lunoshq #13, docs/roles-and-permissions.md):
 *   GET    /v1/account                      who, platformRole, organisations {org,name,role}, terms, deletion, devices
 *   PUT    /v1/account/terms                { terms, privacy }: the current versions, accepted
 *   POST   /v1/account/deletion             deletes the account (409 last_owner while an organisation's only owner)
 *   DELETE /v1/account                      the synced data only (before #13, the only deletion there was)
 *   GET    /v1/billing/usage                the personal plan (`plan`, null when there is none: Free)
 *   GET    /v1/invitations                  invitations to this account's verified address
 *   POST   /v1/invitations/{org}/accept | decline
 * An organisation's (members only; a stranger gets 404, a role that can't gets 403 naming the owners):
 *   GET    /v1/orgs/{org}/owners | members
 *   POST   /v1/orgs/{org}/invitations { email, role }      DELETE /v1/orgs/{org}/invitations/{email}
 *   PUT    /v1/orgs/{org}/members/{sub} { role }           DELETE /v1/orgs/{org}/members/{sub}
 *   POST   /v1/orgs/{org}/transfer { to, demoteTo }
 * Not served yet: POST /v1/account/verification (send the confirmation e-mail again).
 */

export const TIMEOUT_MS = 10_000

export class NotServedError extends Error {
  override name = "CloudAccountNotServed"
  constructor(what: string) {
    super(`${what} isn't available from Lunos Cloud yet.`)
  }
}

/** Lunos Cloud said no: its status, code (`forbidden`, `last_owner`, …) and its own message. */
export class RefusedError extends Error {
  override name = "CloudAccountRefused"
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

export type Options = { fetch?: typeof fetch; endpoint?: string; timeoutMs?: number }

export type Role = "owner" | "admin" | "member"
export type Organisation = { org: string; name: string; role?: Role; suspended?: boolean }
export type Versions = { terms: string; privacy: string }
export type Terms = { current: Versions; accepted?: Versions; needsAcceptance: boolean }

export type Account = {
  sub?: string
  email?: string
  /** "user" or "global_admin", as lunoshq's database says (never the token's claim). */
  platformRole?: string
  organizations: Organisation[]
  devices: { id: string; name: string; platform?: string; revokedAt?: number }[]
  terms?: Terms
  /** Set once the account's deletion was asked for. */
  deletion?: { requestedAt: number; dueAt: number }
  /** Who the account's cloud use is billed to: `user:<sub>`, or `org:<id>` for an organisation's plan. */
  billingSubject?: string
}

/** Whether these calls may go out for a sign-in to `issuer`, and why not. */
export async function allowed(issuer: string): Promise<string | undefined> {
  if (Offline.enabled()) return "offline mode (LUNOS_OFFLINE) is on"
  if (!(await CloudSyncApi.permitted(issuer))) return "your sign-in is your organisation's, not a Lunos account"
}

/**
 * lunoshq answers a route it doesn't have with 404 "No such route." (or 405). Any other 404 is an
 * answer, "No organisation acme." or "That person isn't a member.", and is shown as it is.
 */
const unrouted = (status: number, message: string | undefined) =>
  status === 405 || (status === 404 && (message === undefined || /^No such route\.?$/.test(message)))

export async function call(token: string, method: string, path: string, body: unknown, what: string, opts: Options) {
  const base = opts.endpoint ?? (await CloudSyncApi.endpoint())
  const response = await (opts.fetch ?? fetch)(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A redirect must not carry the token somewhere else.
    redirect: "error",
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  })
  if (!response.ok) {
    const json = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string; message?: string } }
      | undefined
    const message = typeof json?.error?.message === "string" ? json.error.message : undefined
    if (unrouted(response.status, message)) throw new NotServedError(what)
    throw new RefusedError(response.status, message ?? `Lunos Cloud answered ${response.status}`, json?.error?.code)
  }
  if (response.status === 204) return undefined
  return response.json().catch(() => undefined) as Promise<unknown>
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
const num = (value: unknown) => (typeof value === "number" ? value : undefined)
const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : [])
export const role = (value: unknown): Role | undefined =>
  value === "owner" || value === "admin" || value === "member" ? value : undefined

function versions(value: unknown): Versions | undefined {
  const item = value as Record<string, unknown> | null | undefined
  const terms = text(item?.terms)
  const privacy = text(item?.privacy)
  return terms && privacy ? { terms, privacy } : undefined
}

export async function account(token: string, opts: Options = {}): Promise<Account> {
  const body = ((await call(token, "GET", "/v1/account", undefined, "Your account", opts)) ?? {}) as Record<
    string,
    unknown
  >
  const terms = body.terms as Record<string, unknown> | undefined
  const current = versions(terms?.current)
  const deletion = body.deletion as Record<string, unknown> | null | undefined
  const billing = body.billing as Record<string, unknown> | null | undefined
  const requestedAt = num(deletion?.requestedAt)
  return {
    sub: text(body.sub),
    email: text(body.email),
    platformRole: text(body.platformRole),
    organizations: list(body.organizations)
      .filter((item) => text(item?.org))
      .map((item) => ({
        org: String(item.org),
        name: text(item.name) ?? String(item.org),
        role: role(item.role),
        ...(item.suspended === true ? { suspended: true } : {}),
      })),
    devices: list(body.devices)
      .filter((item) => text(item?.id))
      .map((item) => ({
        id: String(item.id),
        name: text(item.name) ?? String(item.id),
        platform: text(item.platform),
        revokedAt: num(item.revokedAt),
      })),
    terms: current
      ? { current, accepted: versions(terms?.accepted), needsAcceptance: terms?.needsAcceptance === true }
      : undefined,
    deletion: requestedAt !== undefined ? { requestedAt, dueAt: num(deletion?.dueAt) ?? requestedAt } : undefined,
    billingSubject: text(billing?.subject),
  }
}

/** The personal plan's id (`pro`, `team`, …), or "free" when the account has none. */
export async function plan(token: string, opts: Options = {}) {
  const body = (await call(token, "GET", "/v1/billing/usage", undefined, "Your plan", opts)) as
    | Record<string, unknown>
    | undefined
  return text(body?.plan) ?? "free"
}

/** Records that the user accepted these versions; lunoshq refuses (400) any but the current ones. */
export async function acceptTerms(token: string, accepted: Versions, opts: Options = {}) {
  await call(token, "PUT", "/v1/account/terms", accepted, "Recording your acceptance of the Terms", opts)
}

export async function resendVerification(token: string, opts: Options = {}) {
  await call(token, "POST", "/v1/account/verification", undefined, "Sending the confirmation e-mail again", opts)
}

/** 409 last_owner: the organisations (ids) whose only owner this account is. Ownership goes first. */
export class LastOwnerError extends Error {
  override name = "CloudAccountLastOwner"
  constructor(
    readonly orgs: string[],
    message: string,
  ) {
    super(message)
  }
}

export type Deleted = {
  sessions?: number
  devices?: number
  /** When the account itself goes; undefined where only the synced data could be deleted. */
  dueAt?: number
}

/**
 * Deletes the account (`POST /v1/account/deletion`). Where Lunos Cloud doesn't serve that yet, only
 * the synced data goes (`DELETE /v1/account`), and `dueAt` is undefined so the screen can say so.
 */
export async function deleteAccount(token: string, opts: Options = {}): Promise<Deleted> {
  const counts = (body: Record<string, unknown>) => ({ sessions: num(body.sessions), devices: num(body.devices) })
  const body = await call(token, "POST", "/v1/account/deletion", undefined, "Deleting your account", opts).then(
    (value) => (value ?? {}) as Record<string, unknown>,
    (error: unknown) => {
      if (error instanceof RefusedError && error.code === "last_owner") {
        // Only in the message: "You're the only owner of acme, beta. Transfer ownership first …".
        const named = /only owner of (.+?)\. /.exec(error.message)?.[1]
        throw new LastOwnerError(named ? named.split(/,\s*/) : [], error.message)
      }
      if (error instanceof NotServedError) return undefined
      throw error
    },
  )
  if (body) {
    const deletion = body.deletion as Record<string, unknown> | undefined
    return { ...counts(body), dueAt: num(deletion?.dueAt) }
  }
  const data = ((await call(token, "DELETE", "/v1/account", undefined, "Deleting your account", opts)) ?? {}) as Record<
    string,
    unknown
  >
  return counts(data)
}

export type Invitation = { org: string; name: string; role?: Role; invitedBy?: string; expiresAt?: number }

/** Invitations to the signed-in account's verified address. */
export async function invitations(token: string, opts: Options = {}): Promise<Invitation[]> {
  const body = (await call(token, "GET", "/v1/invitations", undefined, "Your invitations", opts)) as
    | Record<string, unknown>
    | undefined
  return list(body?.invitations)
    .filter((item) => text(item?.org))
    .map((item) => ({
      org: String(item.org),
      name: text(item.name) ?? String(item.org),
      role: role(item.role),
      invitedBy: text(item.invitedBy),
      expiresAt: num(item.expiresAt),
    }))
}

/** Accepts or declines an invitation; true when accepting made the account a member. */
export async function answerInvitation(token: string, org: string, accept: boolean, opts: Options = {}) {
  const body = (await call(
    token,
    "POST",
    `/v1/invitations/${encodeURIComponent(org)}/${accept ? "accept" : "decline"}`,
    undefined,
    accept ? "Accepting an invitation" : "Declining an invitation",
    opts,
  )) as Record<string, unknown> | undefined
  return body?.joined === true
}
