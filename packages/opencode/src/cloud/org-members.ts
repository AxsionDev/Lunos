export * as CloudOrgMembers from "./org-members"

import { CloudAccountApi } from "./account-api"

/**
 * XCOD-274: an organisation's people on Lunos Cloud, for `lunos org`. lunoshq checks every call
 * against the caller's membership and answers 403 with whom to ask ("Only an organisation owner can
 * do this. Ask: owner@acme.example"), or 404 to someone who isn't a member. Nothing is decided here.
 */

type Options = CloudAccountApi.Options
type Role = CloudAccountApi.Role

export type Member = { sub: string; email?: string; role?: Role; joinedAt?: number; lastSeenAt?: number }
export type Pending = {
  email: string
  role?: Role
  invitedBy?: string
  createdAt?: number
  expiresAt?: number
  expired: boolean
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
const num = (value: unknown) => (typeof value === "number" ? value : undefined)
const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : [])
const path = (org: string, rest: string) => `/v1/orgs/${encodeURIComponent(org)}/${rest}`

const call = (token: string, method: string, at: string, body: unknown, what: string, opts: Options) =>
  CloudAccountApi.call(token, method, at, body, what, opts) as Promise<Record<string, unknown> | undefined>

/** Whom to ask: every member may see the owners. */
export async function owners(token: string, org: string, opts: Options = {}) {
  const body = await call(token, "GET", path(org, "owners"), undefined, "The organisation's owners", opts)
  return list(body?.owners).map((item) => ({ sub: String(item.sub), email: text(item.email) }))
}

/** Members and pending invitations: owners and admins. */
export async function members(token: string, org: string, opts: Options = {}) {
  const body = await call(token, "GET", path(org, "members"), undefined, "The organisation's members", opts)
  return {
    members: list(body?.members).map(
      (item): Member => ({
        sub: String(item.sub),
        email: text(item.email),
        role: CloudAccountApi.role(item.role),
        joinedAt: num(item.joinedAt),
        lastSeenAt: num(item.lastSeenAt),
      }),
    ),
    invitations: list(body?.invitations).map(
      (item): Pending => ({
        email: String(item.email),
        role: CloudAccountApi.role(item.role),
        invitedBy: text(item.invitedBy),
        createdAt: num(item.createdAt),
        expiresAt: num(item.expiresAt),
        expired: item.expired === true,
      }),
    ),
  }
}

export async function invite(token: string, org: string, email: string, role: Role, opts: Options = {}) {
  const body = await call(token, "POST", path(org, "invitations"), { email, role }, "Inviting someone", opts)
  return {
    email: text(body?.email) ?? email,
    role: CloudAccountApi.role(body?.role) ?? role,
    expiresAt: num(body?.expiresAt),
  }
}

export async function revoke(token: string, org: string, email: string, opts: Options = {}) {
  await call(
    token,
    "DELETE",
    path(org, `invitations/${encodeURIComponent(email)}`),
    undefined,
    "Revoking an invitation",
    opts,
  )
}

export async function setRole(token: string, org: string, sub: string, role: Role, opts: Options = {}) {
  await call(token, "PUT", path(org, `members/${encodeURIComponent(sub)}`), { role }, "Changing a role", opts)
}

/** Removes someone; with one's own `sub`, leaves the organisation. */
export async function remove(token: string, org: string, sub: string, opts: Options = {}) {
  await call(token, "DELETE", path(org, `members/${encodeURIComponent(sub)}`), undefined, "Removing a member", opts)
}

/** Hands ownership to a member (`to`: their sub or e-mail address); the caller becomes `demoteTo`. */
export async function transfer(token: string, org: string, to: string, demoteTo: Role, opts: Options = {}) {
  const body = await call(token, "POST", path(org, "transfer"), { to, demoteTo }, "Transferring ownership", opts)
  return { owner: text(body?.owner) ?? to, you: CloudAccountApi.role(body?.you) ?? demoteTo }
}
