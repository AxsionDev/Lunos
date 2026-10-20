// XCOD-273: a fake OpenID Connect provider (device grant, userinfo, revocation, Keycloak's account
// sessions API) and a fake Lunos Cloud account API, on 127.0.0.1, for the sign-in tests. The real
// auth.lunos.tech is never contacted. One server plays both, so a test sets `cloud.issuer` and
// `cloud.endpoint` to the same origin. XCOD-274: Lunos Cloud's routes are fake-lunoshq.ts's, with
// lunoshq #13's contract; by default the signed-in account (u-1) is an Admin of Acme GmbH.

import * as FakeLunoshq from "./fake-lunoshq"

export type Outcome = "ok" | "denied" | "expired" | "unverified" | "pending"

export type Options = {
  /** What the token endpoint answers, per device flow, in order; then "ok". */
  outcomes?: Outcome[]
  /** How many polls stay pending before the outcome. */
  pendingPolls?: number
  /** Userinfo says unverified this many times before it says verified (for "unverified"). */
  verifyAfter?: number
  email?: string
  /** The `lunos_platform_role` claim in the access token (display only; Lunos Cloud's own record wins). */
  platformRole?: string
  /** Sending the confirmation e-mail again isn't served by Lunos Cloud; set to fake that it is. */
  serves?: { verification?: boolean }
  /** Lunos Cloud's accounts and organisations (fake-lunoshq.ts); `defaultCloud` when not set. */
  cloud?: FakeLunoshq.Options
}

/** Pat (u-1, the account the device flow signs in) is an Admin of Acme GmbH, whose owner is Olga. */
export const defaultCloud = (email = "pat@lunos.test"): FakeLunoshq.Options => ({
  users: { "u-1": { email }, "u-owner": { email: "owner@acme.example" } },
  orgs: { acme: { name: "Acme GmbH", members: { "u-owner": "owner", "u-1": "admin" } } },
})

export type Request = { method: string; path: string; auth: string | null; body?: string }

const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

export function start(options: Options = {}) {
  const requests: Request[] = []
  const outcomes = [...(options.outcomes ?? [])]
  const email = options.email ?? "pat@lunos.test"
  let current: Outcome = "ok"
  let polls = 0
  let userinfoCalls = 0
  let verified = true
  const cloud = FakeLunoshq.create(options.cloud ?? defaultCloud(email))
  const state = { sessionsEnded: false, revoked: [] as string[], resent: 0 }
  const access = () =>
    jwt({
      sub: "u-1",
      email,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(options.platformRole ? { lunos_platform_role: options.platformRole } : {}),
    })

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const body = req.method === "GET" ? undefined : await req.text()
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body })
      const form =
        body && req.headers.get("content-type")?.includes("urlencoded") ? new URLSearchParams(body) : undefined
      const origin: string = `http://127.0.0.1:${server.port}`
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: origin,
          device_authorization_endpoint: `${origin}/device`,
          token_endpoint: `${origin}/token`,
          userinfo_endpoint: `${origin}/userinfo`,
          revocation_endpoint: `${origin}/revoke`,
        })
      if (url.pathname === "/device") {
        current = outcomes.shift() ?? "ok"
        polls = 0
        verified = current !== "unverified"
        userinfoCalls = 0
        return Response.json({
          device_code: "dev-code",
          user_code: "WXYZ-2345",
          verification_uri: `${origin}/activate`,
          verification_uri_complete: `${origin}/activate?user_code=WXYZ-2345`,
          expires_in: current === "expired" ? 3 : 600,
          interval: 1,
        })
      }
      if (url.pathname === "/token" && form?.get("grant_type") === "refresh_token")
        return Response.json({ access_token: access(), refresh_token: "rt-2", token_type: "Bearer", expires_in: 3600 })
      if (url.pathname === "/token") {
        polls++
        if (current === "pending" || polls <= (options.pendingPolls ?? 1))
          return Response.json({ error: "authorization_pending" }, { status: 400 })
        if (current === "denied") return Response.json({ error: "access_denied" }, { status: 400 })
        if (current === "expired") return Response.json({ error: "expired_token" }, { status: 400 })
        return Response.json({
          access_token: access(),
          refresh_token: "rt-1",
          id_token: jwt({ sub: "u-1", email, name: "Pat Lunos", email_verified: verified }),
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      if (url.pathname === "/userinfo") {
        userinfoCalls++
        if (!verified && userinfoCalls > (options.verifyAfter ?? 2)) verified = true
        return Response.json({ sub: "u-1", email, name: "Pat Lunos", email_verified: verified })
      }
      if (url.pathname === "/revoke") {
        state.revoked.push(String(form?.get("token")))
        return new Response("")
      }
      if (url.pathname === "/account/sessions" && req.method === "DELETE") {
        state.sessionsEnded = true
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/v1/account/verification" && options.serves?.verification) {
        state.resent++
        return new Response(null, { status: 204 })
      }
      // Lunos Cloud (lunoshq): the account, organisations and session sync's devices.
      if (url.pathname.startsWith("/v1/")) return cloud.handle(req, url, body)
      return Response.json({ error: { code: "not_found", message: "No such route." } }, { status: 404 })
    },
  })
  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    state,
    cloud,
    stop: () => server.stop(true),
  }
}
