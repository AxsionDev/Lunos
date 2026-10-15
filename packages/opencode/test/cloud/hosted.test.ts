// XCOD-242: hosted Lunos Team without device management. After a sign-in to Lunos's own issuer the
// client remembers the account's hosted organisation and turns team features on against the console
// host built into Lunos, and only that host. A fake console on a local port stands in for
// cloud.lunos.tech; the session is a fake token in the file store (never the keychain).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { CloudDefaults } from "../../src/cloud/defaults"
import { CloudHosted } from "../../src/cloud/hosted"
import { CloudOrg } from "../../src/cloud/org"
import { ConfigOrgPolicy } from "../../src/config/org-policy"

let dir: string
let previousData: string
let previousManaged: string | undefined
let restoreHost: () => void
let server: ReturnType<typeof Bun.serve>
let base: string
/** What the fake console's GET /v1/account lists as the account's organisations. */
let organizations: unknown[] = [{ org: "acme", role: "member" }]
const requested: string[] = []

/** An unsigned JWT with these claims (the client never trusts them; they only choose among memberships). */
const jwt = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

const POLICY = { residency: { allow: ["eu"] }, $locked: ["residency"] }
/** What the fake console serves as acme's policy. */
let served: Record<string, unknown> = POLICY

/** A fetch that records every URL and passes the call to the fake console. */
const recording: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requested.push(String(input))
  return fetch(input, init)
}) as typeof fetch

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-hosted-")))
  process.env.LUNOS_CLOUD_STORE = "file"
  previousData = Global.Path.data
  ;(Global.Path as { data: string }).data = path.join(dir, "data")
  previousManaged = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = path.join(dir, "managed")
  await fs.mkdir(path.join(dir, "managed"), { recursive: true })
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (!req.headers.get("authorization")?.startsWith("Bearer "))
        return Response.json({ error: { code: "unauthenticated" } }, { status: 401 })
      if (url.pathname === "/v1/account") return Response.json({ sub: "ada", organizations })
      if (url.pathname === "/v1/orgs/acme/policy") {
        const sha256 = ConfigOrgPolicy.sha256(served)
        return Response.json({ org: "acme", version: 1, sha256, policy: served }, { headers: { etag: `"${sha256}"` } })
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
  restoreHost = CloudHosted.useHostForTests(base)
})

afterAll(async () => {
  restoreHost()
  server.stop(true)
  ;(Global.Path as { data: string }).data = previousData
  if (previousManaged === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousManaged
  delete process.env.LUNOS_CLOUD_STORE
  await fs.rm(dir, { recursive: true, force: true })
})

afterEach(async () => {
  requested.length = 0
  organizations = [{ org: "acme", role: "member" }]
  served = POLICY
  delete process.env.LUNOS_OFFLINE
  await CloudHosted.clear()
  await fs.rm(path.join(dir, "managed", "managed.json"), { force: true })
  await fs.rm(path.join(dir, "data", "cloud"), { recursive: true, force: true })
  ConfigOrgPolicy.reset()
})

const managed = (doc: unknown) => fs.writeFile(path.join(dir, "managed", "managed.json"), JSON.stringify(doc))

/** A Lunos sign-in (or another issuer's), as `lunos login` leaves it: the session in the file store. */
async function signIn(issuer = CloudDefaults.DEFAULT_ISSUER, claims: Record<string, unknown> = {}) {
  const tokens = {
    access_token: jwt({ sub: "ada", ...claims }),
    token_type: "Bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }
  await fs.mkdir(path.join(dir, "data", "cloud"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "data", "cloud", "session.json"),
    JSON.stringify({ issuer, clientID: "lunos-cli", tokens, sub: "ada", savedAt: new Date().toISOString() }),
  )
  return { issuer, sub: "ada", tokens }
}

describe("hosted Team after a Lunos sign-in (XCOD-242)", () => {
  test("AC1: a Lunos sign-in remembers the hosted organisation; the policy and team features use the built-in console", async () => {
    const outcome = await CloudHosted.afterLogin(await signIn(), { fetch: recording })
    expect(outcome).toEqual({ kind: "on", org: "acme" })
    expect(CloudHosted.describe(outcome)).toContain("Team features: on for acme")
    expect(ConfigOrgPolicy.teamSource([])).toEqual({ url: `${base}/v1/orgs/acme/policy`, via: "hosted" })
    // The private marketplace, team memory and sharing all find their console through CloudOrg.
    expect(await CloudOrg.resolve()).toMatchObject({ org: "acme", base: `${base}/v1/orgs/acme` })
    // The organisation policy is fetched at start and applies like managed config.
    const result = await ConfigOrgPolicy.resolve([], { fetch: recording })
    expect([result.source, result.fetch, result.policy]).toEqual(["console", "ok", POLICY])
    expect(requested).toEqual([`${base}/v1/account`, `${base}/v1/orgs/acme/policy`])
  })

  test("AC2: a token claim, the account response or the fetched policy naming another host never causes a request there", async () => {
    // The claim names a host and an organisation the account isn't in; the response lists ids that
    // aren't organisation ids. None of them is used.
    organizations = [{ org: "evil.example" }, { org: "../acme" }, { org: "https://evil.example/v1/orgs/x" }]
    const session = await signIn(CloudDefaults.DEFAULT_ISSUER, { organization: ["evil.example", "other"] })
    expect(await CloudHosted.afterLogin(session, { fetch: recording })).toEqual({
      kind: "several",
      orgs: ["evil.example", "../acme", "https://evil.example/v1/orgs/x"],
    })
    expect(ConfigOrgPolicy.teamSource([])).toBeUndefined()

    // Signed in to acme; the console's own policy then tries to point Lunos at another console.
    organizations = [{ org: "acme" }]
    served = { cloud: { policy: "https://evil.example/v1/orgs/x/policy" } }
    await CloudHosted.afterLogin(await signIn(CloudDefaults.DEFAULT_ISSUER, { organization: "evil" }), {
      fetch: recording,
    })
    // Applied as policy at start (fetched and cached)...
    expect((await ConfigOrgPolicy.resolve([], { fetch: recording })).policy).toEqual(served)
    // ...but the team features' console is still the built-in one.
    expect((await CloudOrg.resolve())?.host).toBe(new URL(base).host)
    // The remembered file names only an organisation; a host written into it is never read.
    const remembered = JSON.parse(await fs.readFile(CloudHosted.file(), "utf8"))
    expect(Object.keys(remembered).sort()).toEqual(["issuer", "org", "savedAt", "sub"])
    await fs.writeFile(CloudHosted.file(), JSON.stringify({ ...remembered, org: "evil.example/v1/orgs/x" }))
    expect(CloudHosted.policyURL()).toBeUndefined()
    expect(requested.every((url) => url.startsWith(`${base}/`))).toBe(true)
  })

  test("the org claim chooses which of the account's hosted organisations, never which host", async () => {
    organizations = [{ org: "acme" }, { org: "beta" }]
    expect(await CloudHosted.afterLogin(await signIn(), { fetch: recording })).toEqual({
      kind: "several",
      orgs: ["acme", "beta"],
    })
    expect(
      await CloudHosted.afterLogin(await signIn(CloudDefaults.DEFAULT_ISSUER, { organization: "beta" }), {
        fetch: recording,
      }),
    ).toEqual({ kind: "on", org: "beta" })
    expect(CloudHosted.policyURL()).toBe(`${base}/v1/orgs/beta/policy`)
  })

  test("a sign-in to any other issuer never auto-enables anything, and forgets an earlier organisation", async () => {
    await CloudHosted.afterLogin(await signIn(), { fetch: recording })
    expect(CloudHosted.policyURL()).toBeDefined()
    requested.length = 0
    const other = await signIn("https://id.acme.example/realms/acme")
    expect(await CloudHosted.afterLogin(other, { fetch: recording })).toEqual({ kind: "off", reason: "issuer" })
    expect(requested).toEqual([])
    expect(CloudHosted.policyURL()).toBeUndefined()
    expect(ConfigOrgPolicy.teamSource([])).toBeUndefined()
  })

  test("AC3: managed cloud.policy always wins; managed cloud.auto_team: false turns hosted off", async () => {
    await CloudHosted.afterLogin(await signIn(), { fetch: recording })
    const pinned = { cloud: { policy: "https://console.acme.eu/v1/orgs/acme/policy" } }
    expect(ConfigOrgPolicy.teamSource([pinned])).toEqual({ url: pinned.cloud.policy, via: "managed" })
    await managed(pinned)
    expect((await CloudOrg.resolve())?.host).toBe("console.acme.eu")
    await managed({ cloud: { auto_team: false } })
    expect(ConfigOrgPolicy.teamSource([{ cloud: { auto_team: false } }])).toBeUndefined()
    expect(await CloudOrg.resolve()).toBeUndefined()
  })

  test("AC4: offline, signed out or without a hosted organisation, nothing new is requested", async () => {
    process.env.LUNOS_OFFLINE = "1"
    expect(await CloudHosted.afterLogin(await signIn(), { fetch: recording })).toEqual({
      kind: "off",
      reason: "offline",
    })
    delete process.env.LUNOS_OFFLINE
    organizations = []
    expect(await CloudHosted.afterLogin(await signIn(), { fetch: recording })).toEqual({ kind: "none" })
    expect(requested).toEqual([`${base}/v1/account`])
    // No hosted organisation: starting Lunos fetches nothing.
    requested.length = 0
    expect(await ConfigOrgPolicy.resolve([], { fetch: recording })).toEqual({ source: "none" })
    expect(requested).toEqual([])
    // Remembered, then signed out: the policy isn't requested without a session.
    organizations = [{ org: "acme" }]
    await CloudHosted.afterLogin(await signIn(), { fetch: recording })
    await fs.rm(path.join(dir, "data", "cloud", "session.json"))
    ConfigOrgPolicy.reset()
    requested.length = 0
    expect((await ConfigOrgPolicy.resolve([], { fetch: recording })).fetch).toBe("signed_out")
    expect(requested).toEqual([])
  })
})
