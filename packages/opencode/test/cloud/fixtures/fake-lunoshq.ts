// XCOD-274: a fake Lunos Cloud control plane on 127.0.0.1 with lunoshq #13's account and
// organisation-membership contract (AxsionDev/lunoshq@5cf1c12: src/org-api.ts, src/server.ts,
// src/platform.ts, console/src/members.ts, docs/roles-and-permissions.md). The statuses, error codes
// and refusal texts are copied from there, so the client is tested against what the server says.
// The caller is whoever the bearer token (a JWT, unsigned here) names; nothing real is contacted.
//
// XCOD-275: by default it speaks the go-live contract (lunoshq xcod-275-server@e0842eb:
// docs/errors.md, src/api-error.ts, src/server.ts, src/platform.ts): refusals are `{ code, message,
// details?, error: { code, message } }`, the nested code the older, more general one; stable codes
// not_member, owner_required and admin_required (the message naming the owners), last_owner with
// `details.orgs`; `GET /v1/account` has `plan` and `plan_source`; `GET /v1/legal` serves the Terms and
// Privacy notice; `POST /v1/account/verification` is rate limited (1 a minute, 5 a day; 429
// `rate_limited` with `details.retryAfterSeconds` and Retry-After; 200 `{ sent, remainingToday }`, 409 `already_verified`). `legacy: true` is lunoshq #13 as
// merged: `{ error: { code, message } }`, `forbidden`, no plan, no legal, no verification route.

export type Role = "owner" | "admin" | "member"
export type Org = { name: string; members: Record<string, Role>; invites?: Record<string, Invite> }
export type Invite = { role: Role; invitedBy: string; createdAt: number }
export type User = { email: string; platformRole?: "user" | "global_admin"; verified?: boolean }

export type Options = {
  users?: Record<string, User>
  orgs?: Record<string, Org>
  terms?: { terms: string; privacy: string }
  /** What each account last accepted (`null`: never). */
  accepted?: Record<string, { terms: string; privacy: string } | null>
  /** The personal plan per account (`null` or missing: Free). */
  plans?: Record<string, string | null>
  /** Routes this server doesn't have yet answer 404 "No such route.", like lunoshq before #13. */
  without?: Array<"deletion" | "terms" | "invitations" | "orgs" | "verification" | "legal">
  /** lunoshq #13 as merged, before XCOD-275 (see above). */
  legacy?: boolean
  /** The plan per account (`free` when missing) and whose it is (`personal` when missing). */
  planSources?: Record<string, string>
  /** Where the Terms and Privacy notice are published (`GET /v1/legal`). */
  legalBase?: string
  devices?: { id: string; name: string; platform?: string; syncEnabled?: boolean; createdAt?: number }[]
}

export type Seen = { method: string; path: string; sub?: string; body?: unknown }

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000
const DELETION_GRACE_MS = 30 * 24 * 3600 * 1000
const MINUTE_MS = 60_000
const DAY_MS = 24 * 3600 * 1000
const ROLES: Role[] = ["owner", "admin", "member"]

// console/src/members.ts MATRIX, for the actions these routes check.
const MATRIX = {
  view_policy: ["owner", "admin", "member"],
  view_members: ["owner", "admin"],
  manage_members: ["owner", "admin"],
  manage_owners: ["owner"],
} as const satisfies Record<string, readonly Role[]>
type Action = keyof typeof MATRIX

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
    /** The nested `error.code` where it differs: the older, more general code (src/api-error.ts). */
    readonly legacy?: string,
  ) {
    super(message)
  }
}

const notAllowed = (action: Action, owners: string[]) => {
  const roles: readonly Role[] = MATRIX[action]
  const who = roles.includes("admin") ? "an organisation owner or admin" : "an organisation owner"
  return `Only ${who} can do this.${owners.length ? ` Ask: ${owners.join(", ")}` : ""}`
}

/** The claims of an unsigned test JWT (`e30.<claims>.sig`). */
function claims(auth: string | null): Record<string, unknown> {
  const token = auth?.replace(/^Bearer\s+/i, "") ?? ""
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
  } catch {
    return {}
  }
}

export const jwt = (body: object) => ["e30", Buffer.from(JSON.stringify(body)).toString("base64url"), "sig"].join(".")

/** The routes, as a handler: the fake identity provider (fake-idp.ts) serves them on its own origin too. */
export function create(options: Options = {}) {
  const users: Record<string, User> = structuredClone(options.users ?? {})
  const orgs: Record<string, Org> = structuredClone(options.orgs ?? {})
  for (const org of Object.values(orgs)) org.invites ??= {}
  let current = options.terms ?? { terms: "2026-10-19", privacy: "2026-10-19" }
  const accepted: Record<string, { terms: string; privacy: string; at: number } | null> = Object.fromEntries(
    Object.entries(options.accepted ?? {}).map(([sub, value]) => [sub, value ? { ...value, at: 1 } : null]),
  )
  const plans = options.plans ?? {}
  const legacy = options.legacy === true
  const without = new Set([...(options.without ?? []), ...(legacy ? (["verification", "legal"] as const) : [])])
  const requests: Seen[] = []
  const legalBase = options.legalBase ?? "https://legal.lunos.test"
  const state = {
    deletion: {} as Record<string, number>,
    deletedData: [] as string[],
    termsPuts: [] as unknown[],
    /** When each account asked for the confirmation e-mail again (ms), and how many were sent. */
    verifications: {} as Record<string, number[]>,
    sent: 0,
    devices: options.devices ?? [
      { id: "dev-other", name: "laptop", platform: "linux", syncEnabled: true, createdAt: 1 },
    ],
  }

  const ownerEmails = (org: string) =>
    Object.entries(orgs[org]!.members)
      .filter(([, role]) => role === "owner")
      .flatMap(([sub]) => (users[sub]?.email ? [users[sub]!.email] : []))

  // Accounts.require: not a member 404 (the organisation isn't confirmed to exist), else 403 naming the owners.
  function require(org: string, sub: string, action: Action) {
    const role = orgs[org]?.members[sub]
    if (!role)
      throw legacy
        ? new ApiError(404, "not_found", `No organisation ${org}.`)
        : new ApiError(404, "not_member", `No organisation ${org}.`, undefined, undefined, "not_found")
    if (!(MATRIX[action] as readonly Role[]).includes(role)) throw refuse(org, action === "manage_owners")
    return role
  }

  /** 403 for a role that can't: #13's `forbidden`, or XCOD-275's code; the message names the owners. */
  function refuse(org: string, ownerOnly: boolean, specific?: string) {
    const message = specific ?? notAllowed(ownerOnly ? "manage_owners" : "manage_members", ownerEmails(org))
    if (legacy) return new ApiError(403, "forbidden", message)
    return new ApiError(
      403,
      ownerOnly ? "owner_required" : "admin_required",
      message,
      undefined,
      undefined,
      "forbidden",
    )
  }

  function keepAnOwner(org: string) {
    if (Object.values(orgs[org]!.members).filter((role) => role === "owner").length > 1) return
    if (legacy)
      throw new ApiError(409, "conflict", "An organisation needs at least one owner. Make someone else an owner first.")
    throw new ApiError(
      409,
      "last_owner",
      "An organisation needs at least one owner. Make someone else an owner first.",
      { orgs: [{ id: org, name: orgs[org]!.name }] },
      undefined,
      "conflict",
    )
  }

  const role = (value: unknown, fallback?: Role): Role => {
    const r = value ?? fallback
    if (typeof r !== "string" || !ROLES.includes(r as Role))
      throw new ApiError(400, "bad_request", `role is one of ${ROLES.join(", ")}.`)
    return r as Role
  }

  const valid = (invite: Invite) => invite.createdAt > Date.now() - INVITE_TTL_MS

  function route(
    method: string,
    path: string,
    sub: string,
    email: string | undefined,
    body: any,
  ): Response | undefined {
    if (path === "/v1/account" && method === "GET") {
      const mine = accepted[sub] ?? null
      return Response.json({
        sub,
        email,
        organizations: Object.entries(orgs)
          .filter(([, org]) => org.members[sub])
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, org]) => ({ org: id, name: org.name, role: org.members[sub] })),
        ssoRequired: [],
        devices: state.devices,
        billing: { subject: `user:${sub}` },
        ...(legacy ? {} : { plan: plans[sub] ?? "free", plan_source: options.planSources?.[sub] ?? "personal" }),
        platformRole: users[sub]?.platformRole ?? "user",
        ...(without.has("terms")
          ? {}
          : {
              terms: {
                current,
                accepted: mine,
                needsAcceptance: !mine || mine.terms !== current.terms || mine.privacy !== current.privacy,
              },
              deletion: state.deletion[sub]
                ? { requestedAt: state.deletion[sub], dueAt: state.deletion[sub]! + DELETION_GRACE_MS }
                : null,
            }),
      })
    }
    if (path === "/v1/account" && method === "DELETE") {
      state.deletedData.push(sub)
      return Response.json({ sessions: 2, devices: state.devices.length })
    }
    if (path === "/v1/billing/usage" && method === "GET")
      return Response.json({ subject: `user:${sub}`, billing: true, plan: plans[sub] ?? null })
    if (path === "/v1/devices" && method === "GET") return Response.json({ devices: state.devices })
    if (path === "/v1/devices" && method === "POST") {
      const device = { id: "dev-this", name: "this", platform: process.platform, syncEnabled: true, createdAt: 2 }
      state.devices = [...state.devices, device]
      return Response.json(device, { status: 201 })
    }

    if (path === "/v1/account/terms" && method === "PUT" && !without.has("terms")) {
      state.termsPuts.push(body)
      if (body?.terms !== current.terms || body?.privacy !== current.privacy)
        throw new ApiError(
          400,
          "bad_request",
          `Accept the current versions: terms ${current.terms}, privacy notice ${current.privacy}.`,
        )
      accepted[sub] = { terms: body.terms, privacy: body.privacy, at: Date.now() }
      return Response.json({ terms: body.terms, privacy: body.privacy, acceptedAt: accepted[sub]!.at })
    }
    if (path === "/v1/account/verification" && method === "POST" && !without.has("verification")) {
      if (users[sub]?.verified) throw new ApiError(409, "already_verified", "Your e-mail address is already verified.")
      const now = Date.now()
      const sent = (state.verifications[sub] ??= []).filter((at) => at > now - DAY_MS)
      const limit = (seconds: number) =>
        new ApiError(
          429,
          "rate_limited",
          "Too many confirmation e-mails.",
          { retryAfterSeconds: seconds, perMinute: 1, perDay: 5 },
          { "retry-after": String(seconds) },
        )
      if (sent.length && sent.at(-1)! > now - MINUTE_MS) throw limit(Math.ceil((sent.at(-1)! + MINUTE_MS - now) / 1000))
      if (sent.length >= 5) throw limit(Math.ceil((sent[0]! + DAY_MS - now) / 1000))
      state.verifications[sub] = [...sent, now]
      state.sent++
      return Response.json({ sent: true, remainingToday: Math.max(0, 5 - sent.length - 1) })
    }
    if (path === "/v1/account/deletion" && method === "POST" && !without.has("deletion")) {
      const only = Object.entries(orgs)
        .filter(
          ([, org]) =>
            org.members[sub] === "owner" && Object.values(org.members).filter((r) => r === "owner").length === 1,
        )
        .map(([id]) => id)
        .sort()
      if (only.length)
        throw new ApiError(
          409,
          "last_owner",
          `You're the only owner of ${only.join(", ")}. Transfer ownership first (POST /v1/orgs/{org}/transfer) or delete the organisation.`,
          legacy ? undefined : { orgs: only.map((id) => ({ id, name: orgs[id]!.name })) },
        )
      for (const org of Object.values(orgs)) delete org.members[sub]
      const now = Date.now()
      state.deletion[sub] = now
      state.deletedData.push(sub)
      return Response.json({
        sessions: 2,
        devices: state.devices.length,
        deletion: { requestedAt: now, dueAt: now + DELETION_GRACE_MS },
      })
    }

    if (!without.has("invitations")) {
      if (path === "/v1/invitations" && method === "GET")
        return Response.json({
          invitations: Object.entries(orgs)
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([id, org]) => {
              const invite = email ? org.invites![email.toLowerCase()] : undefined
              return invite && valid(invite)
                ? [
                    {
                      org: id,
                      role: invite.role,
                      name: org.name,
                      invitedBy: invite.invitedBy,
                      expiresAt: invite.createdAt + INVITE_TTL_MS,
                    },
                  ]
                : []
            }),
        })
      const answer = /^\/v1\/invitations\/([^/]+)\/(accept|decline)$/.exec(path)
      if (answer && method === "POST") {
        const id = decodeURIComponent(answer[1]!)
        const invite = email ? orgs[id]?.invites![email.toLowerCase()] : undefined
        if (!invite || !valid(invite))
          throw new ApiError(
            404,
            "not_found",
            "There's no such invitation, or it expired (invitations last 7 days). Ask an owner to invite you again.",
          )
        delete orgs[id]!.invites![email!.toLowerCase()]
        if (answer[2] === "decline") return Response.json({ org: id, joined: false })
        orgs[id]!.members[sub] = invite.role
        return Response.json({ org: id, joined: true })
      }
    }

    const m = /^\/v1\/orgs\/([^/]+)\/(owners|members|invitations|transfer)(?:\/([^/]+))?$/.exec(path)
    if (!m || without.has("orgs")) return undefined
    const org = decodeURIComponent(m[1]!)
    const area = m[2]!
    const target = m[3] !== undefined ? decodeURIComponent(m[3]) : undefined

    if (area === "owners" && !target && method === "GET") {
      require(org, sub, "view_policy")
      return Response.json({
        owners: Object.entries(orgs[org]!.members)
          .filter(([, r]) => r === "owner")
          .map(([s]) => ({ sub: s, email: users[s]?.email })),
      })
    }
    if (area === "members" && !target && method === "GET") {
      require(org, sub, "view_members")
      const order = { owner: 0, admin: 1, member: 2 }
      return Response.json({
        members: Object.entries(orgs[org]!.members)
          .map(([s, r]) => ({ sub: s, email: users[s]?.email, role: r, joinedAt: 1 }))
          .sort((a, b) => order[a.role] - order[b.role] || String(a.email).localeCompare(String(b.email))),
        invitations: Object.entries(orgs[org]!.invites!)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([address, invite]) => ({
            email: address,
            role: invite.role,
            invitedBy: invite.invitedBy,
            createdAt: invite.createdAt,
            expiresAt: invite.createdAt + INVITE_TTL_MS,
            expired: !valid(invite),
          })),
      })
    }
    if (area === "invitations" && !target && method === "POST") {
      const actor = require(org, sub, "manage_members")
      if (typeof body?.email !== "string") throw new ApiError(400, "bad_request", "email is required.")
      const address = body.email.trim().toLowerCase()
      const invited = role(body.role, "member")
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address))
        throw new ApiError(400, "bad_request", `${body.email} isn't an e-mail address.`)
      if (invited === "owner" && actor !== "owner") throw refuse(org, true, "Only an owner can invite an owner.")
      if (Object.keys(orgs[org]!.members).some((s) => users[s]?.email?.toLowerCase() === address))
        throw new ApiError(409, "conflict", `${address} is already a member.`)
      const invite = { role: invited, invitedBy: sub, createdAt: Date.now() }
      orgs[org]!.invites![address] = invite
      return Response.json(
        { org, email: address, role: invited, expiresAt: invite.createdAt + INVITE_TTL_MS },
        { status: 201 },
      )
    }
    if (area === "invitations" && target && method === "DELETE") {
      const actor = require(org, sub, "manage_members")
      const invite = orgs[org]!.invites![target.toLowerCase()]
      if (!invite) throw new ApiError(404, "not_found", "There's no such invitation.")
      if (invite.role === "owner" && actor !== "owner")
        throw refuse(org, true, "Only an owner can revoke an owner's invitation.")
      delete orgs[org]!.invites![target.toLowerCase()]
      return new Response(null, { status: 204 })
    }
    if (area === "members" && target && method === "PUT") {
      const actor = require(org, sub, "manage_members")
      const to = role(body?.role)
      const from = orgs[org]!.members[target]
      if (!from) throw new ApiError(404, "not_found", "That person isn't a member.")
      if (from === to) return Response.json({ from, to })
      if ((from === "owner" || to === "owner") && actor !== "owner")
        throw refuse(org, true, "Only an owner can grant or take away ownership.")
      if (from === "owner") keepAnOwner(org)
      orgs[org]!.members[target] = to
      return Response.json({ from, to })
    }
    if (area === "members" && target && method === "DELETE") {
      const actor = target === sub ? require(org, sub, "view_policy") : require(org, sub, "manage_members")
      const r = orgs[org]!.members[target]
      if (!r) throw new ApiError(404, "not_found", "That person isn't a member.")
      if (r === "owner" && actor !== "owner") throw refuse(org, true, "Only an owner can remove an owner.")
      if (r === "owner") keepAnOwner(org)
      delete orgs[org]!.members[target]
      return new Response(null, { status: 204 })
    }
    if (area === "transfer" && !target && method === "POST") {
      require(org, sub, "manage_owners")
      if (typeof body?.to !== "string" || !body.to)
        throw new ApiError(400, "bad_request", "to (a member's sub or e-mail address) is required.")
      const to = body.to.includes("@")
        ? Object.keys(orgs[org]!.members).find((s) => users[s]?.email?.toLowerCase() === body.to.toLowerCase())
        : body.to
      if (!to) throw new ApiError(404, "not_found", "That person isn't a member. Invite them first.")
      const demoteTo = role(body.demoteTo, "member")
      if (to === sub) throw new ApiError(400, "bad_request", "Transfer ownership to someone else.")
      if (!orgs[org]!.members[to])
        throw new ApiError(404, "not_found", "That person isn't a member. Invite them first.")
      orgs[org]!.members[to] = "owner"
      orgs[org]!.members[sub] = demoteTo
      return Response.json({ org, owner: to, you: body.demoteTo ?? "member" })
    }
    throw new ApiError(405, "method_not_allowed", "Not here.")
  }

  async function handle(request: Request, url: URL, raw?: string): Promise<Response> {
    const text = raw ?? (request.method === "GET" ? undefined : await request.text())
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    const who = claims(request.headers.get("authorization"))
    const sub = typeof who.sub === "string" ? who.sub : undefined
    requests.push({ method: request.method, path: url.pathname, sub, body })
    // Unauthenticated and cacheable (LUNOSHQ_TERMS_VERSION, LUNOSHQ_PRIVACY_VERSION).
    if (url.pathname === "/v1/legal" && request.method === "GET" && !without.has("legal"))
      return Response.json(
        {
          terms: { version: current.terms, url: `${legalBase}/terms` },
          privacy: { version: current.privacy, url: `${legalBase}/privacy` },
        },
        { headers: { "cache-control": "public, max-age=300" } },
      )
    if (!sub) return Response.json({ error: { code: "unauthenticated", message: "Sign in first." } }, { status: 401 })
    const email = typeof who.email === "string" ? who.email : users[sub]?.email
    users[sub] ??= { email: email ?? `${sub}@lunos.test` }
    if (state.deletion[sub])
      return Response.json(
        { error: { code: "account_deleted", message: "This Lunos account was deleted." } },
        { status: 401 },
      )
    try {
      return (
        route(request.method, url.pathname, sub, email, body) ??
        Response.json(
          legacy
            ? { error: { code: "not_found", message: "No such route." } }
            : { code: "not_found", message: "No such route.", error: { code: "not_found", message: "No such route." } },
          { status: 404 },
        )
      )
    } catch (error) {
      if (error instanceof ApiError)
        return Response.json(
          legacy
            ? { error: { code: error.code, message: error.message } }
            : {
                code: error.code,
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
                error: { code: error.legacy ?? error.code, message: error.message },
              },
          { status: error.status, headers: error.headers },
        )
      throw error
    }
  }

  /** A new Terms or Privacy notice version (LUNOSHQ_TERMS_VERSION, LUNOSHQ_PRIVACY_VERSION). */
  const publish = (next: { terms: string; privacy: string }) => void (current = next)
  return { handle, requests, state, orgs, users, accepted, publish }
}

export type FakeLunoshq = ReturnType<typeof create>

/** On its own port: `cloud.endpoint` for tests whose sign-in is seeded rather than run. */
export function start(options: Options = {}) {
  const fake = create(options)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => fake.handle(req, new URL(req.url)) })
  return { ...fake, server, origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
