// XCOD-185: proves the lunos_idp claim and the realm's clients against a real Keycloak 26.3 in Docker.
// Run from deploy/identity/keycloak: bun test test/lunos-idp.test.ts (skipped when Docker isn't running).
// Everything the tests need beyond the two realm files (a test client, a user, the identity providers)
// is created here through the admin API, so none of it can leak into the production realm file.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  browserLogin,
  claims,
  CookieJar,
  dockerAvailable,
  exchange,
  type Kc,
  passwordGrant,
  refresh,
  startKeycloak,
  TEST_CLIENT,
  TEST_REDIRECT,
  type Tokens,
} from "./keycloak"

setDefaultTimeout(30_000)

const R = "/Lunos"
const PAT = { email: "pat@lunos.test", password: "pat-pass" }
const UPSTREAM = { uma: ["uma", "uma-pass"], vic: ["vic", "vic-pass"], bea: ["bea", "bea-pass"] } as const

const idp = (tokens: Tokens) => ({
  id: claims(tokens.id_token).lunos_idp,
  access: claims(tokens.access_token).lunos_idp,
})

async function clientByClientId(kc: Kc, clientId: string) {
  const [client] = await kc.admin("GET", `${R}/clients?clientId=${clientId}`)
  if (!client) throw new Error(`no client ${clientId}`)
  return client
}

describe.skipIf(!dockerAvailable())("lunos_idp against Keycloak 26.3", () => {
  let kc: Kc
  // Test 3's brokered sign-in: its browser and tokens, reused by the refresh, userinfo and re-authentication tests.
  let acmeJar: CookieJar
  let acme: Tokens

  async function brokered(alias: string, [username, password]: readonly [string, string], jar?: CookieJar) {
    const { code, verifier, jar: used } = await browserLogin(kc, { username, password, idpHint: alias, jar })
    return { tokens: await exchange(kc, TEST_CLIENT, code, verifier), jar: used }
  }

  beforeAll(async () => {
    kc = await startKeycloak()
    try {
      // Keycloak 26 drops attributes its user profile doesn't declare; allow them, or pat's lunos_idp
      // attribute would never be stored and test 2 would prove nothing.
      const profile = await kc.admin("GET", `${R}/users/profile`)
      await kc.admin("PUT", `${R}/users/profile`, { ...profile, unmanagedAttributePolicy: "ENABLED" })

      const cli = await clientByClientId(kc, "lunos-cli")
      const scopes = (kind: string): Promise<string[]> =>
        kc.admin("GET", `${R}/clients/${cli.id}/${kind}`).then((list: { name: string }[]) => list.map((s) => s.name))
      await kc.admin("POST", `${R}/clients`, {
        clientId: TEST_CLIENT,
        enabled: true,
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: true,
        redirectUris: [TEST_REDIRECT],
        attributes: { "pkce.code.challenge.method": "S256" },
        defaultClientScopes: await scopes("default-client-scopes"),
        optionalClientScopes: await scopes("optional-client-scopes"),
      })

      await kc.admin("POST", `${R}/users`, {
        username: PAT.email,
        email: PAT.email,
        emailVerified: true,
        firstName: "Pat",
        lastName: "Lunos",
        enabled: true,
        attributes: { lunos_idp: ["org:evil:x"], lunosIdp: ["org:evil:x"] },
        credentials: [{ type: "password", value: PAT.password, temporary: false }],
      })

      const upstream = await fetch(`${kc.base}/realms/upstream/.well-known/openid-configuration`).then((r) => r.json())
      const provider = (alias: string, lunosIdp?: string) =>
        kc.admin("POST", `${R}/identity-provider/instances`, {
          alias,
          providerId: "oidc",
          enabled: true,
          trustEmail: true,
          firstBrokerLoginFlowAlias: "first broker login",
          config: {
            authorizationUrl: upstream.authorization_endpoint,
            tokenUrl: upstream.token_endpoint,
            jwksUrl: upstream.jwks_uri,
            issuer: upstream.issuer,
            useJwksUrl: "true",
            validateSignature: "true",
            clientId: "lunos-broker",
            clientSecret: "broker-secret",
            clientAuthMethod: "client_secret_post",
            defaultScope: "openid profile email",
            syncMode: "IMPORT",
            ...(lunosIdp === undefined ? {} : { lunosIdp }),
          },
        })
      await provider("acme-entra", "org:acme:entra")
      await provider("plain-upstream")
      await provider("bad-upstream", "ORG:acme:entra")
    } catch (err) {
      await kc.stop()
      throw err
    }
  }, 300_000)

  afterAll(async () => {
    await kc?.stop()
  })

  test("password sign-in is lunos", async () => {
    const tokens = await passwordGrant(kc, TEST_CLIENT, PAT.email, PAT.password)
    expect(idp(tokens)).toEqual({ id: "lunos", access: "lunos" })
    const access = claims(tokens.access_token)
    expect([access.aud].flat()).toContain("lunos-api")
    expect(access.azp).toBe(TEST_CLIENT)
  })

  test("a user attribute named lunos_idp changes nothing", async () => {
    const [pat] = await kc.admin("GET", `${R}/users?email=${encodeURIComponent(PAT.email)}&exact=true`)
    // The attack is real only if the attributes are stored on the user.
    expect(pat.attributes).toMatchObject({ lunos_idp: ["org:evil:x"], lunosIdp: ["org:evil:x"] })
    const tokens = await passwordGrant(kc, TEST_CLIENT, PAT.email, PAT.password)
    expect(idp(tokens)).toEqual({ id: "lunos", access: "lunos" })
  })

  test("an organisation's identity provider is its lunosIdp", async () => {
    const { tokens, jar } = await brokered("acme-entra", UPSTREAM.uma)
    acme = tokens
    acmeJar = jar
    expect(idp(tokens)).toEqual({ id: "org:acme:entra", access: "org:acme:entra" })
    expect([claims(tokens.access_token).aud].flat()).toContain("lunos-api")
  })

  test("refresh keeps the brokered value", async () => {
    const tokens = await refresh(kc, TEST_CLIENT, acme.refresh_token)
    expect(idp(tokens)).toEqual({ id: "org:acme:entra", access: "org:acme:entra" })
  })

  test("a provider without lunosIdp is its alias", async () => {
    const { tokens } = await brokered("plain-upstream", UPSTREAM.vic)
    expect(idp(tokens)).toEqual({ id: "plain-upstream", access: "plain-upstream" })
  })

  test("an invalid lunosIdp falls back to the alias", async () => {
    const { tokens } = await brokered("bad-upstream", UPSTREAM.bea)
    expect(idp(tokens)).toEqual({ id: "bad-upstream", access: "bad-upstream" })
  })

  test("userinfo carries it", async () => {
    const res = await fetch(`${kc.base}/realms/Lunos/protocol/openid-connect/userinfo`, {
      headers: { authorization: `Bearer ${acme.access_token}` },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).lunos_idp).toBe("org:acme:entra")
  })

  test("re-authentication with a password in the same browser session", async () => {
    // uma, first signed in through acme-entra, now signs in with a Lunos password in the same browser.
    const [uma] = await kc.admin("GET", `${R}/users?email=${encodeURIComponent("uma@acme.test")}&exact=true`)
    await kc.admin("PUT", `${R}/users/${uma.id}/reset-password`, { type: "password", value: "uma-local", temporary: false })
    const { code, verifier, posted } = await browserLogin(kc, {
      username: "uma@acme.test",
      password: "uma-local",
      jar: acmeJar,
      extra: { prompt: "login" },
    })
    // prompt=login made Keycloak ask again: the password went to Lunos's own login form, not upstream's.
    expect(posted.some((step) => step.startsWith("/realms/Lunos/login-actions/") && step.includes("password"))).toBe(true)
    const tokens = await exchange(kc, TEST_CLIENT, code, verifier)
    const [before, after] = [claims(acme.id_token), claims(tokens.id_token)]
    console.log(
      `re-authentication: sid before ${before.sid}, after ${after.sid};`,
      `auth_time before ${before.auth_time}, after ${after.auth_time};`,
      `lunos_idp ${JSON.stringify(idp(tokens))}; forms posted: ${JSON.stringify(posted)}`,
    )
    expect(idp(tokens)).toEqual({ id: "lunos", access: "lunos" })
  })

  test("the realm's clients are as specified", async () => {
    for (const clientId of ["lunos-cli", "lunos-app", "lunos-console"]) {
      const client = await clientByClientId(kc, clientId)
      const scopes: { name: string }[] = await kc.admin("GET", `${R}/clients/${client.id}/default-client-scopes`)
      expect(scopes.map((s) => s.name)).toContain("lunos")
    }

    const webClient = {
      publicClient: false,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      frontchannelLogout: false,
    }
    const app = await clientByClientId(kc, "lunos-app")
    expect(app).toMatchObject({
      ...webClient,
      redirectUris: ["https://app.lunos.tech/auth/callback"],
      webOrigins: ["https://app.lunos.tech"],
    })
    expect(app.attributes).toMatchObject({
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": "https://app.lunos.tech/",
      "backchannel.logout.url": "https://app.lunos.tech/auth/backchannel-logout",
      "backchannel.logout.session.required": "true",
    })

    const console_ = await clientByClientId(kc, "lunos-console")
    expect(console_).toMatchObject({
      ...webClient,
      redirectUris: ["https://cloud.lunos.tech/console/callback"],
      webOrigins: ["https://cloud.lunos.tech"],
    })
    expect(console_.attributes).toMatchObject({
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": "https://cloud.lunos.tech/console/",
    })

    const consoleAdmin = await clientByClientId(kc, "lunos-console-admin")
    expect(consoleAdmin).toMatchObject({
      publicClient: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
    })
    const account = await kc.admin("GET", `${R}/clients/${consoleAdmin.id}/service-account-user`)
    const realmManagement = await clientByClientId(kc, "realm-management")
    const clientRoles: { name: string }[] = await kc.admin(
      "GET",
      `${R}/users/${account.id}/role-mappings/clients/${realmManagement.id}`,
    )
    expect(clientRoles.map((r) => r.name)).toEqual(["manage-identity-providers"])
    const realmRoles: { name: string }[] = await kc.admin("GET", `${R}/users/${account.id}/role-mappings/realm`)
    expect(realmRoles.map((r) => r.name).filter((name) => name !== "default-roles-lunos")).toEqual([])
  })
})
