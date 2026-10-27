export * as CloudAccountApi from "./account-api"

import { Offline } from "@opencode-ai/core/offline"
import { CloudDisabled } from "./disabled"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-273/274: the account and organisation calls /account, the sign-in screen and `lunos org` make
 * to Lunos Cloud's control plane (lunoshq), with the session's own token. Only for a sign-in Lunos
 * Cloud may receive (`CloudSyncApi.permitted`: Lunos's own issuer, or a configured `cloud.endpoint`),
 * never offline. Every permission is decided there; this side only shows the answer.
 *
 * The account (lunoshq #13, docs/roles-and-permissions.md; XCOD-275):
 *   GET    /v1/account                      who, platformRole, organisations {org,name,role}, terms, deletion,
 *                                           devices, plan (free/pro/team/enterprise) and plan_source
 *   PUT    /v1/account/terms                { terms, privacy }: the current versions, accepted
 *   POST   /v1/account/deletion             deletes the account (409 last_owner while an organisation's only owner)
 *   DELETE /v1/account                      the synced data only (before #13, the only deletion there was)
 *   POST   /v1/account/verification         sends the confirmation e-mail again (429: 1 a minute, 5 a day)
 *   GET    /v1/invitations                  invitations to this account's verified address
 *   POST   /v1/invitations/{org}/accept | decline
 * An organisation's (members only; a stranger gets 404, a role that can't gets 403):
 *   GET    /v1/orgs/{org}/owners | members
 *   POST   /v1/orgs/{org}/invitations { email, role }      DELETE /v1/orgs/{org}/invitations/{email}
 *   PUT    /v1/orgs/{org}/members/{sub} { role }           DELETE /v1/orgs/{org}/members/{sub}
 *   POST   /v1/orgs/{org}/transfer { to, demoteTo }
 *
 * XCOD-275: a refusal is `{ code, message, details? }` (also accepted inside `{ error: … }`, as #13
 * sends it). What it says here is chosen by `code`, never by the message's words; the message is
 * shown only for a code this client doesn't know, or from a server that sends none.
 */

export const TIMEOUT_MS = 10_000

export class NotServedError extends Error {
  override name = "CloudAccountNotServed"
  constructor(what: string) {
    super(`${what} isn't available from Lunos Cloud yet.`)
  }
}

/** An organisation a refusal names: `last_owner`'s `details.orgs`. */
export type Named = { id: string; name: string }

/**
 * Lunos Cloud said no. `message` is what to show for its `code` (see `explain`); `serverMessage` is
 * its own words, `details` its machine-readable part, and `retryAfter` (seconds) when it said when.
 */
export class RefusedError extends Error {
  override name = "CloudAccountRefused"
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
    readonly serverMessage?: string,
    readonly retryAfter?: number,
    /** The nested `error.code` where it differs: the older, more general code (`forbidden`). */
    readonly legacyCode?: string,
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
  /** XCOD-275: the plan the account is on (`free`, `pro`, `team`, `enterprise`), as Lunos Cloud says. */
  plan?: string
  /** Whose plan it is: "personal", or the id of the organisation whose plan the account uses. */
  planSource?: string
}

/** Whether these calls may go out for a sign-in to `issuer`, and why not. */
export async function allowed(issuer: string): Promise<string | undefined> {
  if (Offline.enabled()) return "offline mode (LUNOS_OFFLINE) is on"
  if (!(await CloudSyncApi.permitted(issuer))) return "your sign-in is your organisation's, not a Lunos account"
}

/**
 * A refusal's parts. lunoshq (docs/errors.md) sends `{ code, message, details?, error: { code,
 * message } }`, where the nested `error.code` is the older, more general one (`forbidden`): the
 * top-level fields win. #13 sent only the nested object.
 */
export type Refusal = { code?: string; message?: string; details?: Record<string, unknown>; legacyCode?: string }

export function refusal(body: unknown): Refusal {
  const outer = (body ?? {}) as Record<string, unknown>
  const inner =
    typeof outer.code !== "string" && outer.error && typeof outer.error === "object"
      ? (outer.error as Record<string, unknown>)
      : outer
  const details = inner.details ?? outer.details
  const nested =
    outer.error && typeof outer.error === "object" ? text((outer.error as Record<string, unknown>).code) : undefined
  return {
    code: text(inner.code),
    message: text(inner.message),
    details: details && typeof details === "object" ? (details as Record<string, unknown>) : undefined,
    legacyCode: nested && nested !== text(inner.code) ? nested : undefined,
  }
}

/**
 * A route the server doesn't have: 405, a 404 with code `no_route`, or (lunoshq #13, which answers
 * every unknown route 404 `not_found` "No such route.") that exact message. That one string is the
 * only message this client compares, and only to tell an older server apart.
 */
const unrouted = (status: number, found: Refusal) =>
  status === 405 ||
  (status === 404 &&
    (found.code === "no_route" || found.message === undefined || /^No such route\.?$/.test(found.message)))

/** "45 seconds", "3 minutes", "2 hours": how long until a rate limit lets the next try through. */
export function wait(seconds: number) {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
  if (seconds < 60) return unit(Math.max(1, Math.ceil(seconds)), "second")
  if (seconds < 3600) return unit(Math.ceil(seconds / 60), "minute")
  return unit(Math.ceil(seconds / 3600), "hour")
}

/** `last_owner`'s organisations: `details.orgs` ([{ id, name }]). */
export function named(details: Record<string, unknown> | undefined): Named[] {
  return list(details?.orgs)
    .filter((item) => text(item?.id))
    .map((item) => ({ id: String(item.id), name: text(item.name) ?? String(item.id) }))
}

/** "Acme GmbH (acme)", or just the id where the name is the id. */
export const orgLabel = (org: Named) => (org.name !== org.id ? `${org.name} (${org.id})` : org.id)

/**
 * Whom to ask. lunoshq names the owners in its message ("… Ask: owner@acme.example"), so that is
 * shown as it is; `details.owners` ([{ sub, email }]), where a server sends it, is used instead.
 */
const ask = (said: string, details: Record<string, unknown> | undefined, message: string | undefined) => {
  const owners = list(details?.owners).flatMap((item) => (text(item?.email) ? [String(item.email)] : []))
  if (owners.length) return `${said} Ask: ${owners.join(", ")}`
  return message ?? said
}

/** Codes from before XCOD-275 that mean the same as a current one. */
const ALIASES: Record<string, string> = {
  org_suspended: "suspended",
  account_suspended: "suspended",
  email_unverified: "unverified",
}

/**
 * What a refusal says, chosen by its code. Undefined for a code this client doesn't know (the
 * server's own message is shown then), and for `not_found`, whose message names what wasn't found.
 */
export function explain(
  code: string | undefined,
  details?: Record<string, unknown>,
  retryAfter?: number,
  message?: string,
) {
  switch (code && (ALIASES[code] ?? code)) {
    case "not_member":
      return "You aren't a member of that organisation. Ask one of its owners to invite you."
    case "owner_required":
      return ask("Only an organisation owner can do this.", details, message)
    case "admin_required":
      return ask("Only an organisation owner or admin can do this.", details, message)
    case "last_owner": {
      const orgs = named(details)
      if (!orgs.length) return
      return `You're the only owner of ${orgs.map(orgLabel).join(", ")}. Transfer ownership first, with lunos org transfer <member> --org ${orgs[0]!.id}, or delete the organisation.`
    }
    case "suspended":
      return "This organisation or account is suspended, so Lunos Cloud refused this. Its owner can ask Lunos support why."
    case "unverified":
      return "Confirm your e-mail address first: open the link in the e-mail Lunos sent you, then try again."
    case "break_glass_required":
      return "This needs an active break-glass grant, which only Lunos platform staff can request."
    case "reauth_required":
      return "This needs a recent sign-in. Sign in again (lunos login, or /login in the TUI), then try again."
    case "already_verified":
      return "Your e-mail address is already confirmed. Choose I've confirmed it, or sign in again."
    case "rate_limited":
      return retryAfter !== undefined
        ? `Too many requests. Try again in ${wait(retryAfter)}.`
        : "Too many requests. Try again later."
    // XCOD-317: the refusals on the way to a first cloud run (lunoshq docs/errors.md, "Refused cloud runs").
    case "not_admitted":
      return "Lunos Cloud isn't open to your account yet. Local Lunos is unaffected."
    case "no_git_token": {
      const host = text(details?.host) ?? "your repository's host"
      return `Lunos Cloud clones your repository and pushes the results with your own git token, and none is stored for ${host}. Store one with lunos cloud git-token set ${text(details?.host) ?? "<host>"} (or run lunos cloud quickstart, which asks for it).`
    }
    case "spending_cap":
      return runRefusal(text(details?.reason))
    case "concurrency_limit":
      return runRefusal(text(details?.reason))
  }
}

/** A refused cloud run's next step, by `details.reason`; undefined where the server's own words say it best. */
function runRefusal(reason: string | undefined) {
  switch (reason) {
    case "no_plan":
      return "Cloud runs need a plan. Run lunos cloud quickstart to start the 14-day Pro trial, or ask an owner of your organisation for the Team plan."
    case "payment_failed":
      return "Your last payment failed, so cloud runs are paused. Update your payment details in the billing portal, and they start again; local Lunos is unaffected."
    case "capacity":
      return "Lunos Cloud has too many cloud runs at once right now, so no worker is free. Try again in a few minutes."
    case "hybrid_capacity":
      return "Your organisation runs cloud tasks on its own workers, and too many cloud runs at once are on them (or they're offline). Wait for one to finish, or ask an admin to check them."
    case "plan_concurrency":
    case "trial_concurrency":
      return "Your plan already has as many cloud runs at once as it allows (too many cloud runs at once for your plan). Wait for one to finish."
  }
}

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
    const found = refusal(await response.json().catch(() => undefined))
    if (unrouted(response.status, found)) throw new NotServedError(what)
    const seconds = Number(response.headers.get("retry-after") ?? found.details?.retryAfterSeconds)
    const retryAfter = Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
    // A 429 without a code is still a rate limit.
    const code = found.code ?? (response.status === 429 ? "rate_limited" : undefined)
    // XCOD-312: the account itself is disabled: recorded here, whichever call found it (several
    // callers swallow their errors), so the TUI shows the screen and the session loop refuses prompts.
    const disabled = CloudDisabled.suspension(response.status, found)
    if (disabled) await CloudDisabled.record(disabled).catch(() => undefined)
    throw new RefusedError(
      response.status,
      (disabled && CloudDisabled.text(disabled)) ??
        explain(code, found.details, retryAfter, found.message) ??
        found.message ??
        `Lunos Cloud answered ${response.status}`,
      found.code,
      found.details,
      found.message,
      retryAfter,
      found.legacyCode,
    )
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
    plan: text(body.plan),
    planSource: text(body.plan_source ?? body.planSource),
  }
}

/** Records that the user accepted these versions; lunoshq refuses (400) any but the current ones. */
export async function acceptTerms(token: string, accepted: Versions, opts: Options = {}) {
  await call(token, "PUT", "/v1/account/terms", accepted, "Recording your acceptance of the Terms", opts)
}

export async function resendVerification(token: string, opts: Options = {}) {
  await call(token, "POST", "/v1/account/verification", undefined, "Sending the confirmation e-mail again", opts)
}

/** 409 last_owner: the organisations whose only owner this account is. Ownership goes first. */
export class LastOwnerError extends Error {
  override name = "CloudAccountLastOwner"
  constructor(
    readonly orgs: Named[],
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
        const orgs = named(error.details)
        if (orgs.length) throw new LastOwnerError(orgs, error.message)
        // lunoshq #13 names them only in its message: "You're the only owner of acme, beta. Transfer …".
        const ids = /only owner of (.+?)\. /.exec(error.serverMessage ?? "")?.[1]?.split(/,\s*/) ?? []
        throw new LastOwnerError(
          ids.map((id) => ({ id, name: id })),
          error.message,
        )
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
