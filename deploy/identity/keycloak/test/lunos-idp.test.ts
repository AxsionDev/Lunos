// XCOD-185: proves the lunos_idp claim and the realm's clients against a real Keycloak 26.3 in Docker.
// Run from deploy/identity/keycloak: bun test test/lunos-idp.test.ts (skipped when Docker isn't running).
// Everything the tests need beyond the two realm files (a test client, a user, the identity providers)
// is created here through the admin API, so none of it can leak into the production realm file.
// The last tests run configure-realm.ts against a third realm, OldLunos, imported from dev's realm file;
// they need origin/dev locally (git fetch origin dev).
import { rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  browserLogin,
  claims,
  CookieJar,
  deviceLogin,
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
import { configure } from "../configure-realm"

setDefaultTimeout(30_000)

const R = "/Lunos"
const SECOND_CLIENT = "lunos-test-2"
const PAT = { email: "pat@lunos.test", password: "pat-pass" }
const UPSTREAM = {
  uma: ["uma", "uma-pass"],
  vic: ["vic", "vic-pass"],
  bea: ["bea", "bea-pass"],
  dee: ["dee", "dee-pass"],
} as const
const UMA_LOCAL = "uma-local"

const idp = (tokens: Tokens) => ({
  id: claims(tokens.id_token).lunos_idp,
  access: claims(tokens.access_token).lunos_idp,
})

// The realm as it is live before XCOD-185: dev's realm file, renamed so it imports beside Lunos.
const OLD = "OldLunos"
const OLD_FILE = "test/.old-lunos.json"
// Entries an operator added by hand to a client before configure-realm.ts ran; they must survive it.
type Extras = { redirectUris: string[]; webOrigins: string[]; postLogout: string[] }
const NO_EXTRAS: Extras = { redirectUris: [], webOrigins: [], postLogout: [] }
const OLD_CONSOLE_EXTRAS: Extras = {
  redirectUris: ["http://localhost:3000/console/callback"],
  webOrigins: ["http://localhost:3000"],
  postLogout: ["http://localhost:3000/console/"],
}
const OLD_CONSOLE_SECRET = "old-console-secret"

function writeOldRealm() {
  const dir = path.resolve(import.meta.dir, "..")
  const out = Bun.spawnSync(["git", "show", "origin/dev:deploy/identity/keycloak/realm-lunos.json"], { cwd: dir })
  if (out.exitCode !== 0) throw new Error(`git show origin/dev's realm file: ${out.stderr.toString()}`)
  writeFileSync(path.join(dir, OLD_FILE), JSON.stringify({ ...JSON.parse(out.stdout.toString()), realm: OLD }))
}

async function clientByClientId(kc: Kc, clientId: string, realm = R) {
  const [client] = await kc.admin("GET", `${realm}/clients?clientId=${clientId}`)
  if (!client) throw new Error(`no client ${clientId}`)
  return client
}

const sorted = (xs: string[]) => [...xs].sort()

/** A web client's URI lists are exactly `want`'s plus `extras`, in any order. */
function expectUris(client: any, want: { redirect: string; origin: string; postLogout: string }, extras: Extras) {
  expect(sorted(client.redirectUris)).toEqual(sorted([want.redirect, ...extras.redirectUris]))
  expect(sorted(client.webOrigins)).toEqual(sorted([want.origin, ...extras.webOrigins]))
  expect(sorted(client.attributes["post.logout.redirect.uris"].split("##"))).toEqual(
    sorted([want.postLogout, ...extras.postLogout]),
  )
}

const APP_URIS = {
  redirect: "https://app.lunos.tech/auth/callback",
  origin: "https://app.lunos.tech",
  postLogout: "https://app.lunos.tech/",
}

/**
 * Test 8's assertions on the clients, for any realm (path form, "/Lunos"). A client's URI lists must be
 * exactly the bundle's plus its `extras`.
 */
async function expectClientsAsSpecified(kc: Kc, realm: string, extras: { app?: Extras; console?: Extras } = {}) {
  for (const clientId of ["lunos-cli", "lunos-app", "lunos-console"]) {
    const client = await clientByClientId(kc, clientId, realm)
    const scopes: { name: string }[] = await kc.admin("GET", `${realm}/clients/${client.id}/default-client-scopes`)
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
  const app = await clientByClientId(kc, "lunos-app", realm)
  expect(app).toMatchObject(webClient)
  expectUris(app, APP_URIS, extras.app ?? NO_EXTRAS)
  expect(app.attributes).toMatchObject({
    "pkce.code.challenge.method": "S256",
    "backchannel.logout.url": "https://app.lunos.tech/auth/backchannel-logout",
    "backchannel.logout.session.required": "true",
  })

  const console_ = await clientByClientId(kc, "lunos-console", realm)
  expect(console_).toMatchObject(webClient)
  expectUris(
    console_,
    {
      redirect: "https://cloud.lunos.tech/console/callback",
      origin: "https://cloud.lunos.tech",
      postLogout: "https://cloud.lunos.tech/console/",
    },
    extras.console ?? NO_EXTRAS,
  )
  expect(console_.attributes).toMatchObject({ "pkce.code.challenge.method": "S256" })

  const consoleAdmin = await clientByClientId(kc, "lunos-console-admin", realm)
  expect(consoleAdmin).toMatchObject({
    publicClient: false,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: true,
  })
  const bundle = await Bun.file(path.resolve(import.meta.dir, "../realm-lunos.json")).json()
  const wantAdminScopes: string[] = bundle.clients.find(
    (c: any) => c.clientId === "lunos-console-admin",
  ).defaultClientScopes
  const adminScopes: { name: string }[] = await kc.admin(
    "GET",
    `${realm}/clients/${consoleAdmin.id}/default-client-scopes`,
  )
  // Keycloak attaches its built-in service_account scope to a client created with a service account
  // through the admin API (configure-realm.ts's path), though not on import.
  expect(sorted(adminScopes.map((s) => s.name).filter((name) => name !== "service_account"))).toEqual(
    sorted(wantAdminScopes),
  )
  const account = await kc.admin("GET", `${realm}/clients/${consoleAdmin.id}/service-account-user`)
  const realmManagement = await clientByClientId(kc, "realm-management", realm)
  const clientRoles: { name: string }[] = await kc.admin(
    "GET",
    `${realm}/users/${account.id}/role-mappings/clients/${realmManagement.id}`,
  )
  expect(clientRoles.map((r) => r.name)).toEqual(["manage-identity-providers"])
  const realmRoles: { name: string }[] = await kc.admin("GET", `${realm}/users/${account.id}/role-mappings/realm`)
  expect(
    realmRoles.map((r) => r.name).filter((name) => name !== `default-roles-${realm.slice(1).toLowerCase()}`),
  ).toEqual([])
}

describe.skipIf(!dockerAvailable())("lunos_idp against Keycloak 26.3", () => {
  let kc: Kc
  // Test 3's brokered sign-in: its browser and tokens, reused by the refresh, userinfo, SSO and re-authentication tests.
  let acmeJar: CookieJar
  let acme: Tokens
  // The tokens after re-authenticating with a password (A) and through the organisation's provider (C).
  let afterPassword: Tokens
  let afterBroker: Tokens

  async function brokered(
    alias: string,
    [username, password]: readonly [string, string],
    opts: { jar?: CookieJar; extra?: Record<string, string>; scope?: string } = {},
  ) {
    const { code, verifier, jar, posted } = await browserLogin(kc, { username, password, idpHint: alias, ...opts })
    return { tokens: await exchange(kc, TEST_CLIENT, code, verifier), jar, posted }
  }

  beforeAll(async () => {
    // Written before Docker mounts it: a missing host file would become a root-owned directory.
    writeOldRealm()
    kc = await startKeycloak({ realmFiles: ["realm-lunos.json", "test/upstream-realm.json", OLD_FILE] })
    try {
      // Startup waits only for Lunos; a skipped import would otherwise surface as a 404 tests later.
      await kc.admin("GET", `/${OLD}`)
      // OldLunos half-done by hand: lunos-console exists (configure-realm.ts updates it, keeping the
      // operator's extras and secret); lunos-app and lunos-console-admin don't (it creates them, as live).
      await kc.admin("POST", `/${OLD}/clients`, {
        clientId: "lunos-console",
        enabled: true,
        publicClient: false,
        standardFlowEnabled: true,
        secret: OLD_CONSOLE_SECRET,
        redirectUris: OLD_CONSOLE_EXTRAS.redirectUris,
        webOrigins: OLD_CONSOLE_EXTRAS.webOrigins,
        attributes: { "x.lunos.test": "keep", "post.logout.redirect.uris": OLD_CONSOLE_EXTRAS.postLogout.join("##") },
      })
      // Keycloak 26 drops attributes its user profile doesn't declare; allow them, or pat's lunos_idp
      // attribute would never be stored and test 2 would prove nothing.
      const profile = await kc.admin("GET", `${R}/users/profile`)
      await kc.admin("PUT", `${R}/users/profile`, { ...profile, unmanagedAttributePolicy: "ENABLED" })

      const cli = await clientByClientId(kc, "lunos-cli")
      const scopes = (kind: string): Promise<string[]> =>
        kc.admin("GET", `${R}/clients/${cli.id}/${kind}`).then((list: { name: string }[]) => list.map((s) => s.name))
      // A second client stands in for "the console after signing in to the app": cookie SSO between clients.
      for (const clientId of [TEST_CLIENT, SECOND_CLIENT]) {
        await kc.admin("POST", `${R}/clients`, {
          clientId,
          enabled: true,
          publicClient: true,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: clientId === TEST_CLIENT,
          redirectUris: [TEST_REDIRECT],
          attributes: { "pkce.code.challenge.method": "S256" },
          defaultClientScopes: await scopes("default-client-scopes"),
          optionalClientScopes: await scopes("optional-client-scopes"),
        })
      }

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
    rmSync(path.resolve(import.meta.dir, "..", OLD_FILE), { force: true })
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

  test("a cookie sign-in to another client keeps the brokered value", async () => {
    // Signing in to the console after the app must not lose the org value, or enforce-SSO would lock the user out.
    const { code, verifier, posted } = await browserLogin(kc, {
      username: "unused",
      password: "unused",
      jar: acmeJar,
      clientId: SECOND_CLIENT,
    })
    expect(posted).toEqual([])
    const tokens = await exchange(kc, SECOND_CLIENT, code, verifier)
    expect(claims(tokens.id_token).sid).toBe(claims(acme.id_token).sid)
    expect(idp(tokens)).toEqual({ id: "org:acme:entra", access: "org:acme:entra" })
  })

  test("re-authentication with a password in the same browser session", async () => {
    // uma, first signed in through acme-entra, now signs in with a Lunos password in the same browser.
    const [uma] = await kc.admin("GET", `${R}/users?email=${encodeURIComponent("uma@acme.test")}&exact=true`)
    await kc.admin("PUT", `${R}/users/${uma.id}/reset-password`, {
      type: "password",
      value: UMA_LOCAL,
      temporary: false,
    })
    const { code, verifier, posted } = await browserLogin(kc, {
      username: "uma@acme.test",
      password: UMA_LOCAL,
      jar: acmeJar,
      extra: { prompt: "login" },
    })
    // prompt=login made Keycloak ask again: the password went to Lunos's own login form, not upstream's.
    expect(posted.some((step) => step.startsWith("/realms/Lunos/login-actions/") && step.includes("password"))).toBe(
      true,
    )
    const tokens = await exchange(kc, TEST_CLIENT, code, verifier)
    expect(claims(tokens.id_token).sid).toBe(claims(acme.id_token).sid)
    expect(idp(tokens)).toEqual({ id: "lunos", access: "lunos" })
    afterPassword = tokens
  })

  test("refresh after a password re-authentication keeps lunos", async () => {
    const tokens = await refresh(kc, TEST_CLIENT, afterPassword.refresh_token)
    expect(idp(tokens)).toEqual({ id: "lunos", access: "lunos" })
  })

  test("re-authentication through the organisation's provider is its lunosIdp", async () => {
    // uma (whose Lunos password the previous tests set) signs in with it in a new browser, then
    // re-authenticates through acme-entra in the same browser.
    const first = await browserLogin(kc, { username: "uma@acme.test", password: UMA_LOCAL })
    const password = await exchange(kc, TEST_CLIENT, first.code, first.verifier)
    expect(idp(password)).toEqual({ id: "lunos", access: "lunos" })
    const { tokens, posted } = await brokered("acme-entra", UPSTREAM.uma, {
      jar: first.jar,
      extra: { prompt: "login" },
    })
    // The re-authentication really went through the upstream realm's login form.
    expect(posted.some((step) => step.startsWith("/realms/upstream/") && step.includes("password"))).toBe(true)
    expect(claims(tokens.id_token).sid).toBe(claims(password.id_token).sid)
    expect(idp(tokens)).toEqual({ id: "org:acme:entra", access: "org:acme:entra" })
    afterBroker = tokens
  })

  test("refresh after re-authentication through the provider keeps it", async () => {
    const tokens = await refresh(kc, TEST_CLIENT, afterBroker.refresh_token)
    expect(idp(tokens)).toEqual({ id: "org:acme:entra", access: "org:acme:entra" })
  })

  // Keycloak removes an online session that was created for an offline token, so a later sign-in in that
  // browser starts a new session. An offline session is reused only when the online session it was
  // copied from lives on: sign in, take an offline token by cookie, then re-authenticate.
  const ORG = { id: "org:acme:entra", access: "org:acme:entra" }
  const OWN = { id: "lunos", access: "lunos" }
  const offline = { scope: "openid offline_access" }

  test("offline: a password re-authentication drops the org value from the offline session too", async () => {
    const { tokens: viaBroker, jar } = await brokered("acme-entra", UPSTREAM.uma)
    const sso = await browserLogin(kc, { username: "unused", password: "unused", jar, ...offline })
    expect(sso.posted).toEqual([])
    const first = await exchange(kc, TEST_CLIENT, sso.code, sso.verifier)
    expect(claims(first.refresh_token).typ).toBe("Offline")
    expect(idp(await refresh(kc, TEST_CLIENT, first.refresh_token))).toEqual(ORG)

    const again = await browserLogin(kc, {
      username: "uma@acme.test",
      password: UMA_LOCAL,
      jar,
      extra: { prompt: "login" },
      ...offline,
    })
    const viaPassword = await exchange(kc, TEST_CLIENT, again.code, again.verifier)
    expect(claims(viaPassword.id_token).sid).toBe(claims(viaBroker.id_token).sid)
    expect(idp(viaPassword)).toEqual(OWN)
    expect(idp(await refresh(kc, TEST_CLIENT, viaPassword.refresh_token))).toEqual(OWN)
    // The earlier offline token belongs to the same, reused offline session.
    expect(idp(await refresh(kc, TEST_CLIENT, first.refresh_token))).toEqual(OWN)
  })

  test("offline: a re-authentication through the provider gives the offline session the org value", async () => {
    const start = await browserLogin(kc, { username: "uma@acme.test", password: UMA_LOCAL })
    const viaPassword = await exchange(kc, TEST_CLIENT, start.code, start.verifier)
    const sso = await browserLogin(kc, { username: "unused", password: "unused", jar: start.jar, ...offline })
    expect(sso.posted).toEqual([])
    const first = await exchange(kc, TEST_CLIENT, sso.code, sso.verifier)
    expect(idp(await refresh(kc, TEST_CLIENT, first.refresh_token))).toEqual(OWN)

    const { tokens: viaBroker } = await brokered("acme-entra", UPSTREAM.uma, {
      jar: start.jar,
      extra: { prompt: "login" },
      ...offline,
    })
    expect(claims(viaBroker.id_token).sid).toBe(claims(viaPassword.id_token).sid)
    expect(idp(await refresh(kc, TEST_CLIENT, viaBroker.refresh_token))).toEqual(ORG)
    expect(idp(await refresh(kc, TEST_CLIENT, first.refresh_token))).toEqual(ORG)
  })

  test("device sign-in (lunos login) through the organisation's provider is its lunosIdp", async () => {
    // dee is new to Lunos: the first broker login creates her account during the device sign-in.
    const { tokens, posted } = await deviceLogin(kc, {
      username: UPSTREAM.dee[0],
      password: UPSTREAM.dee[1],
      idpLink: "acme-entra",
      ...offline,
    })
    expect(posted.some((step) => step.startsWith("/realms/upstream/") && step.includes("password"))).toBe(true)
    expect(claims(tokens.access_token).azp).toBe("lunos-cli")
    expect(idp(tokens)).toEqual(ORG)
    expect(idp(await refresh(kc, "lunos-cli", tokens.refresh_token))).toEqual(ORG)
  })

  test("device sign-in approved by the session cookie keeps the brokered value", async () => {
    const { jar } = await brokered("acme-entra", UPSTREAM.uma)
    const { tokens, posted } = await deviceLogin(kc, { username: "unused", password: "unused", jar, ...offline })
    // No credentials asked for: only the device confirmation and consent pages.
    expect(posted.filter((step) => /password|username/.test(step))).toEqual([])
    expect(idp(tokens)).toEqual(ORG)
    expect(idp(await refresh(kc, "lunos-cli", tokens.refresh_token))).toEqual(ORG)
  })

  test("the realm's clients are as specified", async () => {
    await expectClientsAsSpecified(kc, R)
  })

  test("without the lunos-idp event listener a brokered sign-in says lunos (fails closed)", async () => {
    const config = await kc.admin("GET", `${R}/events/config`)
    expect(config.eventsListeners).toContain("lunos-idp")
    await kc.admin("PUT", `${R}/events/config`, { ...config, eventsListeners: ["jboss-logging"] })
    try {
      const { tokens } = await brokered("acme-entra", UPSTREAM.uma)
      expect(idp(tokens)).toEqual({ id: "lunos", access: "lunos" })
    } finally {
      await kc.admin("PUT", `${R}/events/config`, config)
    }
  })

  // configure-realm.ts against OldLunos. In order: the refusals and the dry run must leave the realm
  // as imported, the real run changes it, and a second run finds nothing left to do.
  const oldEnv = () => ({ KC_URL: kc.base, KC_REALM: OLD, KC_ADMIN_USER: "admin", KC_ADMIN_PASSWORD: "admin" })

  /** A fetch whose serverinfo is the real one, edited; every other request goes to Keycloak unchanged. */
  const serverinfoWithout = (edit: (info: any) => void): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init)
      if (!String(input).endsWith("/admin/serverinfo")) return res
      const info = await res.json()
      edit(info)
      return Response.json(info)
    }) as typeof fetch

  async function oldRealmState() {
    const scopes: { name: string }[] = await kc.admin("GET", `/${OLD}/client-scopes`)
    const clients: { clientId: string }[] = await kc.admin("GET", `/${OLD}/clients`)
    const defaults: { name: string }[] = await kc.admin("GET", `/${OLD}/default-default-client-scopes`)
    const cli = await clientByClientId(kc, "lunos-cli", `/${OLD}`)
    const cliScopes: { name: string }[] = await kc.admin("GET", `/${OLD}/clients/${cli.id}/default-client-scopes`)
    const console_ = await clientByClientId(kc, "lunos-console", `/${OLD}`)
    return {
      console: console_,
      consoleSecret: (await kc.admin("GET", `/${OLD}/clients/${console_.id}/client-secret`)).value,
      scopes: scopes.map((s) => s.name).sort(),
      clients: clients.map((c) => c.clientId).sort(),
      defaults: defaults.map((s) => s.name).sort(),
      cliScopes: cliScopes.map((s) => s.name).sort(),
      listeners: (await kc.admin("GET", `/${OLD}/events/config`)).eventsListeners,
    }
  }
  let asImported: Awaited<ReturnType<typeof oldRealmState>>

  test("configure refuses without the mapper or without the event listener", async () => {
    asImported = await oldRealmState()
    expect(asImported.scopes).not.toContain("lunos")
    expect(asImported.clients).not.toContain("lunos-app")

    const noMapper = serverinfoWithout((info) => {
      info.protocolMapperTypes["openid-connect"] = info.protocolMapperTypes["openid-connect"].filter(
        (m: { id: string }) => m.id !== "lunos-idp-mapper",
      )
    })
    await expect(configure(oldEnv(), noMapper)).rejects.toThrow(/protocol mapper lunos-idp-mapper[\s\S]*build\.sh/)

    const noListener = serverinfoWithout((info) => {
      delete info.providers.eventsListener.providers["lunos-idp"]
    })
    await expect(configure(oldEnv(), noListener)).rejects.toThrow(/event listener lunos-idp[\s\S]*build\.sh/)
    expect(await oldRealmState()).toEqual(asImported)
  })

  test("configure refuses a lunos scope whose mapper has another type, before changing anything", async () => {
    // A throwaway realm: OldLunos must stay as imported for the tests after this one.
    await kc.admin("POST", "", { realm: "BadScope", enabled: true })
    await kc.admin("POST", "/BadScope/clients", { clientId: "lunos-cli", publicClient: true })
    await kc.admin("POST", "/BadScope/client-scopes", {
      name: "lunos",
      protocol: "openid-connect",
      protocolMappers: [
        {
          name: "lunos_idp",
          protocol: "openid-connect",
          protocolMapper: "oidc-hardcoded-claim-mapper",
          config: { "claim.name": "lunos_idp", "claim.value": "lunos" },
        },
      ],
    })
    const state = async () => ({
      clients: (await kc.admin("GET", "/BadScope/clients")).map((c: { clientId: string }) => c.clientId).sort(),
      defaults: (await kc.admin("GET", "/BadScope/default-default-client-scopes"))
        .map((s: { name: string }) => s.name)
        .sort(),
      listeners: (await kc.admin("GET", "/BadScope/events/config")).eventsListeners,
    })
    const before = await state()
    await expect(configure({ ...oldEnv(), KC_REALM: "BadScope" })).rejects.toThrow(
      /mapper lunos_idp is a oidc-hardcoded-claim-mapper/,
    )
    expect(await state()).toEqual(before)
    await kc.admin("DELETE", "/BadScope")
  })

  test("configure makes a public lunos-app confidential, with a secret, keeping its extras", async () => {
    // A throwaway realm: OldLunos's lunos-app takes the create path, so the conversion is proven here.
    const extras: Extras = {
      redirectUris: ["http://localhost:3000/auth/callback"],
      webOrigins: ["http://localhost:3000"],
      postLogout: ["http://localhost:3000/"],
    }
    await kc.admin("POST", "", { realm: "ConvRealm", enabled: true })
    try {
      await kc.admin("POST", "/ConvRealm/clients", { clientId: "lunos-cli", publicClient: true })
      await kc.admin("POST", "/ConvRealm/clients", {
        clientId: "lunos-app",
        enabled: true,
        publicClient: true,
        standardFlowEnabled: true,
        redirectUris: extras.redirectUris,
        webOrigins: extras.webOrigins,
        attributes: { "x.lunos.test": "keep", "post.logout.redirect.uris": extras.postLogout[0] },
      })
      const changes = await configure({ ...oldEnv(), KC_REALM: "ConvRealm" })
      expect(changes).toContain("create client scope lunos (mappers lunos_idp, lunos-api audience)")
      const app = await clientByClientId(kc, "lunos-app", "/ConvRealm")
      expect(app).toMatchObject({ publicClient: false, standardFlowEnabled: true, directAccessGrantsEnabled: false })
      expectUris(app, APP_URIS, extras)
      expect(app.attributes).toMatchObject({ "x.lunos.test": "keep", "pkce.code.challenge.method": "S256" })
      expect((await kc.admin("GET", `/ConvRealm/clients/${app.id}/client-secret`)).value).toBeTruthy()
      expect(await configure({ ...oldEnv(), KC_REALM: "ConvRealm" })).toEqual([])
    } finally {
      await kc.admin("DELETE", "/ConvRealm")
    }
  })

  test("configure with DRY_RUN plans the changes and makes none", async () => {
    const planned = await configure({ ...oldEnv(), DRY_RUN: "1" })
    expect(planned.length).toBeGreaterThan(0)
    expect(planned.join("\n")).toContain("lunos-console-admin")
    expect(await oldRealmState()).toEqual(asImported)
  })

  test("configure brings an old realm to the new shape", async () => {
    const changes = await configure(oldEnv())
    expect(changes).toContain("create client lunos-app")
    expect(changes).toContain("create client lunos-console-admin")

    // lunos-app was created (exactly as specified, no extras); lunos-console was updated.
    await expectClientsAsSpecified(kc, `/${OLD}`, { console: OLD_CONSOLE_EXTRAS })
    const app = await clientByClientId(kc, "lunos-app", `/${OLD}`)
    expect((await kc.admin("GET", `/${OLD}/clients/${app.id}/client-secret`)).value).toBeTruthy()
    const console_ = await clientByClientId(kc, "lunos-console", `/${OLD}`)
    expect(console_.attributes["x.lunos.test"]).toBe("keep")
    expect((await kc.admin("GET", `/${OLD}/clients/${console_.id}/client-secret`)).value).toBe(OLD_CONSOLE_SECRET)
    const config = await kc.admin("GET", `/${OLD}/events/config`)
    expect(config.eventsListeners).toContain("lunos-idp")
    expect(config.eventsListeners).toContain("jboss-logging")

    // A client created afterwards takes the realm's default scopes, lunos among them.
    await kc.admin("POST", `/${OLD}/clients`, {
      clientId: TEST_CLIENT,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: true,
    })
    await kc.admin("POST", `/${OLD}/users`, {
      username: PAT.email,
      email: PAT.email,
      emailVerified: true,
      firstName: "Pat",
      lastName: "Lunos",
      enabled: true,
      credentials: [{ type: "password", value: PAT.password, temporary: false }],
    })
    const tokens = await passwordGrant(kc, TEST_CLIENT, PAT.email, PAT.password, OLD)
    expect(idp(tokens)).toEqual({ id: "lunos", access: "lunos" })
    expect([claims(tokens.access_token).aud].flat()).toContain("lunos-api")
  })

  test("configure is idempotent", async () => {
    expect(await configure(oldEnv())).toEqual([])
  })
})
