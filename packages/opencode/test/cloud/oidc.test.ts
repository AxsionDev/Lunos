import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CloudOidc } from "../../src/cloud/oidc"

// XCOD-185: a small OpenID Connect provider with the device grant, enough to exercise every
// outcome of the flow. The real flow was also checked against Keycloak 26 (see the PR).
let server: ReturnType<typeof Bun.serve>
let issuer = ""
const state = { polls: 0, script: [] as string[], revoked: [] as string[], refreshes: 0 }
const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? new URLSearchParams(await req.text()) : undefined
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          device_authorization_endpoint: `${issuer}/device`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          revocation_endpoint: `${issuer}/revoke`,
        })
      if (url.pathname === "/device") {
        if (body?.get("client_id") !== "lunos-cli") return Response.json({ error: "invalid_client" }, { status: 401 })
        return Response.json({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: `${issuer}/activate`,
          verification_uri_complete: `${issuer}/activate?user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        })
      }
      if (url.pathname === "/token" && body?.get("grant_type") === "refresh_token") {
        state.refreshes++
        if (body.get("refresh_token") !== "rt-1") return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: "at-2", token_type: "Bearer", expires_in: 300 })
      }
      if (url.pathname === "/token") {
        state.polls++
        const next = state.script.shift() ?? "ok"
        if (next !== "ok") return Response.json({ error: next }, { status: 400 })
        return Response.json({
          access_token: "at-1",
          refresh_token: "rt-1",
          id_token: jwt({ sub: "u-1", email: "from-token@lunos.test" }),
          token_type: "Bearer",
          expires_in: 300,
        })
      }
      if (url.pathname === "/userinfo") {
        if (!req.headers.get("authorization")?.startsWith("Bearer at-")) return new Response("", { status: 401 })
        return Response.json({ sub: "u-1", email: "dev@lunos.test", organization: { axsion: {} } })
      }
      if (url.pathname === "/revoke") {
        state.revoked.push(String(body?.get("token")))
        return new Response("")
      }
      return new Response("not found", { status: 404 })
    },
  })
  issuer = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

const noSleep = () => Promise.resolve()

describe("CloudOidc (XCOD-185)", () => {
  test("discovery needs the device grant and the right issuer", async () => {
    const discovery = await CloudOidc.discover(issuer + "/")
    expect(discovery.device_authorization_endpoint).toBe(`${issuer}/device`)
    await expect(CloudOidc.discover("http://127.0.0.1:1")).rejects.toThrow(/Couldn't reach/)
    await expect(CloudOidc.discover(`${issuer}/nope`)).rejects.toThrow(/answered 404/)
  })

  test("pending and slow_down keep polling, then the tokens and the user come back", async () => {
    state.script = ["authorization_pending", "slow_down", "authorization_pending"]
    state.polls = 0
    const waits: number[] = []
    const discovery = await CloudOidc.discover(issuer)
    const device = await CloudOidc.startDevice(discovery, "lunos-cli")
    expect(device.user_code).toBe("ABCD-EFGH")
    const tokens = await CloudOidc.waitForTokens(discovery, "lunos-cli", device, {
      sleep: async (ms) => void waits.push(ms),
    })
    expect(state.polls).toBe(4)
    // slow_down adds 5 seconds to the interval (RFC 8628 §3.5).
    expect(waits).toEqual([1000, 1000, 6000, 6000])
    expect(tokens.refresh_token).toBe("rt-1")
    const user = await CloudOidc.user(discovery, tokens)
    expect(user).toMatchObject({ sub: "u-1", email: "dev@lunos.test", organizations: ["axsion"] })
  })

  test("a denied or expired code ends with a clear message", async () => {
    const discovery = await CloudOidc.discover(issuer)
    const device = await CloudOidc.startDevice(discovery, "lunos-cli")
    state.script = ["access_denied"]
    await expect(CloudOidc.waitForTokens(discovery, "lunos-cli", device, { sleep: noSleep })).rejects.toThrow(/denied/)
    state.script = ["expired_token"]
    await expect(CloudOidc.waitForTokens(discovery, "lunos-cli", device, { sleep: noSleep })).rejects.toThrow(/expired/)
    await expect(CloudOidc.startDevice(discovery, "someone-else")).rejects.toThrow(/refused/)
  })

  test("refresh keeps the refresh token when the provider doesn't rotate it, and fails when it's revoked", async () => {
    const discovery = await CloudOidc.discover(issuer)
    const next = await CloudOidc.refresh(discovery, "lunos-cli", {
      access_token: "at-1",
      refresh_token: "rt-1",
      token_type: "Bearer",
    })
    expect(next).toMatchObject({ access_token: "at-2", refresh_token: "rt-1" })
    await expect(
      CloudOidc.refresh(discovery, "lunos-cli", { access_token: "x", refresh_token: "gone", token_type: "Bearer" }),
    ).rejects.toThrow(/run lunos login again/)
  })

  test("logout revokes the refresh token", async () => {
    const discovery = await CloudOidc.discover(issuer)
    expect(
      await CloudOidc.revoke(discovery, "lunos-cli", {
        access_token: "a",
        refresh_token: "rt-9",
        token_type: "Bearer",
      }),
    ).toBe(true)
    expect(state.revoked).toContain("rt-9")
  })

  test("a revoked access token reads as signed out, not as a user", async () => {
    const discovery = await CloudOidc.discover(issuer)
    await expect(CloudOidc.user(discovery, { access_token: "bogus", token_type: "Bearer" })).rejects.toThrow(
      /expired or was revoked/,
    )
  })
})
