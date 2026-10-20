import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { AccountError, needsAcceptance } from "@opencode-ai/tui/util/account"
import { CloudAuth } from "../../src/cloud/auth"
import { CloudDefaults } from "../../src/cloud/defaults"
import { CloudGate } from "../../src/cloud/gate"
import { CloudStore } from "../../src/cloud/store"
import { CloudTuiHost } from "../../src/cloud/tui-host"
import * as FakeIdp from "./fixtures/fake-idp"

// XCOD-273: the TUI's sign-in host against a fake provider and a fake Lunos Cloud on 127.0.0.1, with
// the stand-in keychain (LUNOS_CLOUD_STORE=test-keychain): never the real keychain or auth.lunos.tech.

const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")
const tty = { stdin: true, stdout: true }

describe("CloudGate.resolve (XCOD-273)", () => {
  const base = { managed: [] as unknown[], global: {}, env: {}, tty, official: true }

  test("the official build on an interactive terminal requires a sign-in, to Lunos's own issuer", () => {
    expect(CloudGate.resolve(base)).toEqual({ required: true, issuer: CloudDefaults.DEFAULT_ISSUER })
  })

  test("a build from source is exempt, unless LUNOS_AUTH_REQUIRED or managed auth.required: true", () => {
    expect(CloudGate.resolve({ ...base, official: false })).toMatchObject({
      required: false,
      exemption: "source-build",
    })
    expect(CloudGate.resolve({ ...base, official: false, env: { LUNOS_AUTH_REQUIRED: "1" } }).required).toBe(true)
    expect(CloudGate.resolve({ ...base, official: false, managed: [{ auth: { required: true } }] }).required).toBe(true)
  })

  test("each exemption skips the Welcome screen", () => {
    const cases: [Partial<CloudGate.Input>, string][] = [
      [{ managed: [{ auth: { required: false } }] }, "managed"],
      [{ managed: [{ cloud: { issuer: "https://id.acme.eu/realms/acme" } }] }, "org-issuer"],
      [{ env: { LUNOS_OFFLINE: "1" } }, "offline"],
      [{ env: { CI: "true" } }, "ci"],
      [{ tty: { stdin: false, stdout: true } }, "headless"],
      [{ tty: { stdin: true, stdout: false } }, "headless"],
    ]
    for (const [input, exemption] of cases)
      expect(CloudGate.resolve({ ...base, ...input })).toMatchObject({ required: false, exemption })
  })

  test("managed auth.required: false wins over everything, a project can't set it, and env can't turn it off", () => {
    expect(
      CloudGate.resolve({ ...base, managed: [{ auth: { required: true } }, { auth: { required: false } }] }),
    ).toMatchObject({ exemption: "managed" })
    // The user's own config isn't read for auth.required.
    expect(CloudGate.resolve({ ...base, global: { auth: { required: false } } }).required).toBe(true)
    expect(CloudGate.resolve({ ...base, env: { LUNOS_AUTH_REQUIRED: "0" } }).required).toBe(true)
  })

  test("managed cloud.issuer set to Lunos's own isn't an organisation's issuer", () => {
    expect(
      CloudGate.resolve({ ...base, managed: [{ cloud: { issuer: CloudDefaults.DEFAULT_ISSUER + "/" } }] }).required,
    ).toBe(true)
  })

  test("the Welcome screen signs in to managed, then global cloud.issuer, never a project's", () => {
    expect(CloudGate.issuer({ managed: [], global: { cloud: { issuer: "https://id.me.eu" } } })).toBe(
      "https://id.me.eu",
    )
    expect(
      CloudGate.issuer({ managed: [{ cloud: { issuer: "https://id.org.eu" } }], global: { cloud: { issuer: "x" } } }),
    ).toBe("https://id.org.eu")
  })

  test("deciding makes no network call", async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("no network in this test")
    }) as unknown as typeof fetch
    try {
      await CloudGate.current(tty)
    } finally {
      globalThis.fetch = original
    }
    expect(calls).toBe(0)
  })
})

describe("CloudTuiHost (XCOD-273)", () => {
  let idp: ReturnType<typeof FakeIdp.start>
  let dir: string
  const previous = { data: Global.Path.data, config: Global.Path.config }
  const configFile = () => path.join(Global.Path.config, "opencode.json")

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-signin-"))
    process.env.LUNOS_CLOUD_STORE = "test-keychain"
  })
  afterAll(async () => {
    delete process.env.LUNOS_CLOUD_STORE
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function setup(options: FakeIdp.Options = {}) {
    idp = FakeIdp.start(options)
    const data = await fs.mkdtemp(path.join(dir, "data-"))
    const config = await fs.mkdtemp(path.join(dir, "config-"))
    ;(Global.Path as { data: string }).data = data
    ;(Global.Path as { config: string }).config = config
    // Session sync and the account API go to the fake control plane, as global cloud.endpoint says.
    await fs.writeFile(configFile(), JSON.stringify({ cloud: { issuer: idp.origin, endpoint: idp.origin } }))
    return CloudTuiHost.create({
      gate: { required: true, issuer: idp.origin },
      issuer: idp.origin,
      clientID: "lunos-cli",
    })
  }
  beforeEach(() => {
    delete process.env.LUNOS_TOKEN
  })
  afterEach(() => {
    idp?.stop()
    ;(Global.Path as { data: string }).data = previous.data
    ;(Global.Path as { config: string }).config = previous.config
  })

  test("device flow → confirmed → kept in the keychain; then /logout", async () => {
    const host = await setup()
    expect(await host.current()).toBeUndefined()
    const flow = await host.start({ signup: true })
    expect(flow.userCode).toBe("WXYZ-2345")
    expect(flow.urlComplete).toContain("user_code=WXYZ-2345")
    expect(flow.expiresAt).toBeGreaterThan(Date.now())
    const pending = await flow.wait(new AbortController().signal)
    expect(pending.verified).toBe(true)
    const user = await pending.save()
    expect(user).toMatchObject({ email: "pat@lunos.test", kept: "the test keychain" })
    // No billing call while signing in (XCOD-273): the plan is /account's.
    expect(idp.requests.filter((request) => /billing|checkout|card/.test(request.path))).toEqual([])
    // In the (stand-in) keychain, not in session.json.
    const keychain = JSON.parse(await fs.readFile(CloudStore.testKeychain(), "utf8"))
    expect(JSON.parse(keychain.secret).tokens.refresh_token).toBe("rt-1")
    expect(await Bun.file(path.join(Global.Path.data, "cloud", "session.json")).exists()).toBe(false)
    expect((await host.current())?.email).toBe("pat@lunos.test")
    expect(await host.logout()).toEqual({ revoked: true })
    expect(idp.state.revoked).toEqual(["rt-1"])
    expect(await host.current()).toBeUndefined()
  })

  test("denied, expired, offline and unreachable each fail with their own kind", async () => {
    const host = await setup({ outcomes: ["denied", "expired"] })
    const kind = (promise: Promise<unknown>) =>
      promise.then(
        () => "none",
        (error) => (error instanceof AccountError ? error.kind : `not an AccountError: ${error}`),
      )
    const signal = new AbortController().signal
    expect(await kind((await host.start({ signup: false })).wait(signal))).toBe("denied")
    expect(await kind((await host.start({ signup: false })).wait(signal))).toBe("expired")
    const offline = CloudTuiHost.create({
      gate: { required: true, issuer: "x" },
      issuer: "https://lunos-test-offline.invalid",
      clientID: "lunos-cli",
    })
    expect(await kind(offline.start({ signup: false }))).toBe("offline")
    const down = CloudTuiHost.create({
      gate: { required: true, issuer: "x" },
      issuer: "http://127.0.0.1:1",
      clientID: "c",
    })
    expect(await kind(down.start({ signup: false }))).toBe("unreachable")
  }, 20_000)

  test("an unconfirmed e-mail waits: nothing is kept until the address is confirmed", async () => {
    const host = await setup({ outcomes: ["unverified"], verifyAfter: 2, serves: { verification: true } })
    const pending = await (await host.start({ signup: true })).wait(new AbortController().signal)
    expect(pending.verified).toBe(false)
    expect(pending.email).toBe("pat@lunos.test")
    await expect(pending.save()).rejects.toMatchObject({ kind: "unverified" })
    expect(await host.current()).toBeUndefined()
    await pending.resend()
    expect(idp.state.resent).toBe(1)
    expect(await pending.recheck()).toBe(false)
    expect(await pending.recheck()).toBe(true)
    expect((await pending.save()).email).toBe("pat@lunos.test")
  })

  test("Resend says so when Lunos Cloud doesn't serve it yet", async () => {
    const host = await setup({ outcomes: ["unverified"] })
    const pending = await (await host.start({ signup: true })).wait(new AbortController().signal)
    await expect(pending.resend()).rejects.toMatchObject({ kind: "unavailable" })
  })

  const signIn = async (host: Awaited<ReturnType<typeof setup>>) =>
    (await (await host.start({ signup: false })).wait(new AbortController().signal)).save()

  test("/account: user, plan, role, organisations with roles and names, invitations, devices (XCOD-274)", async () => {
    let host = await setup({
      platformRole: "support",
      cloud: {
        ...FakeIdp.defaultCloud(),
        orgs: {
          acme: { name: "Acme GmbH", members: { "u-owner": "owner", "u-1": "owner" } },
          beta: { name: "Beta Ltd", members: { "u-owner": "owner", "u-1": "member" } },
          gamma: {
            name: "Gamma AG",
            members: { "u-owner": "owner" },
            invites: { "pat@lunos.test": { role: "admin", invitedBy: "u-owner", createdAt: Date.now() } },
          },
        },
        plans: { "u-1": "pro" },
      },
    })
    await signIn(host)
    const details = await host.details()
    expect(details.user.plan).toBe("Pro")
    // Lunos Cloud's record, not the token's claim ("support" grants nothing).
    expect(details.platformRole).toBe("user")
    expect(details.organisations).toEqual([
      { org: "acme", name: "Acme GmbH", role: "owner" },
      { org: "beta", name: "Beta Ltd", role: "member" },
    ])
    expect(details.invitations).toEqual([
      { org: "gamma", name: "Gamma AG", role: "admin", invitedBy: "u-owner", expiresAt: expect.any(Number) },
    ])
    expect(details.devices?.map((d) => [d.name, d.current])).toEqual([["laptop", false]])
    // The sign-in asked for at start doesn't turn session sync on: no device is registered.
    expect(idp.requests.some((request) => request.method === "POST" && request.path === "/v1/devices")).toBe(false)
    expect(details.missing).toEqual([])
    expect(await host.answerInvitation!("gamma", true)).toBe("You joined Gamma AG as an admin.")
    expect((await host.details()).organisations?.map((o) => o.org)).toEqual(["acme", "beta", "gamma"])
    idp.stop()

    // No personal plan: Free. Before XCOD-274's server, no role or invitations, and nothing is made up.
    host = await setup({ platformRole: "support", cloud: { ...FakeIdp.defaultCloud(), without: ["invitations"] } })
    await signIn(host)
    const older = await host.details()
    expect(older.user.plan).toBe("Free")
    expect(older.invitations).toBeUndefined()
    expect(older.missing).toEqual([])
  }, 20_000)

  test("sign out everywhere ends the provider's sessions, then signs out here", async () => {
    const host = await setup()
    await signIn(host)
    expect(await host.logoutEverywhere()).toEqual({ ended: true })
    expect(idp.state.sessionsEnded).toBe(true)
    expect(await host.current()).toBeUndefined()
  })

  test("Delete my account: POST /v1/account/deletion, then signed out and the keychain cleared (XCOD-274)", async () => {
    const host = await setup()
    await signIn(host)
    const result = await host.deleteAccount()
    expect(result).toMatchObject({ deleted: true })
    expect(result.message).toMatch(/^Your Lunos account will be deleted on \d{4}-\d\d-\d\d\. /)
    expect(idp.cloud.state.deletion["u-1"]).toBeNumber()
    expect(
      idp.requests
        .filter((r) => r.path.startsWith("/v1/account") && r.method !== "GET")
        .map((r) => `${r.method} ${r.path}`),
    ).toEqual(["POST /v1/account/deletion"])
    expect(await host.current()).toBeUndefined()
    expect(await Bun.file(CloudStore.testKeychain()).exists()).toBe(false)
  })

  test("Delete my account as an organisation's only owner: 409 last_owner, named, and nothing changes", async () => {
    const host = await setup({
      cloud: {
        ...FakeIdp.defaultCloud(),
        orgs: {
          acme: { name: "Acme GmbH", members: { "u-1": "owner", "u-2": "member" } },
          beta: { name: "Beta Ltd", members: { "u-1": "owner", "u-owner": "owner" } },
        },
      },
    })
    await signIn(host)
    const result = await host.deleteAccount()
    expect(result).toEqual({
      deleted: false,
      title: "Transfer ownership first",
      message:
        "You're the only owner of Acme GmbH (acme). Transfer ownership first, with lunos org transfer <member> --org acme or delete the organisation. Then delete your account.",
    })
    // Still signed in, still a member: Lunos Cloud refused, so nothing happened.
    expect((await host.current())?.email).toBe("pat@lunos.test")
    expect(idp.cloud.state.deletion["u-1"]).toBeUndefined()
    expect(idp.cloud.orgs.acme!.members["u-1"]).toBe("owner")
  })

  test("Delete my account where Lunos Cloud has no deletion yet: the synced data only, and it says so", async () => {
    const host = await setup({ cloud: { ...FakeIdp.defaultCloud(), without: ["deletion"] } })
    await signIn(host)
    const result = await host.deleteAccount()
    expect(result).toMatchObject({ deleted: true })
    expect(result.message).toContain("This Lunos Cloud doesn't delete the account itself yet")
    expect(idp.cloud.state.deletedData).toEqual(["u-1"])
    expect(await host.current()).toBeUndefined()
  })

  test("Terms: the box ticked at sign-in is sent to Lunos Cloud once; an older record asks again (XCOD-274)", async () => {
    let host = await setup({
      cloud: { ...FakeIdp.defaultCloud(), terms: { terms: "2026-10-19", privacy: "2026-10-19" } },
    })
    expect(needsAcceptance(host.legal, await host.accepted())).toBe(true)
    await host.accept(host.legal.version)
    await signIn(host)
    expect(await host.accepted()).toBe(host.legal.version)
    expect(needsAcceptance({ ...host.legal, version: "2099-01-01" }, await host.accepted())).toBe(true)
    // Nothing recorded at Lunos Cloud yet, and the version ticked here is its current one: sent, not asked.
    expect(await host.termsCheck!()).toBeUndefined()
    expect(idp.cloud.state.termsPuts).toEqual([{ terms: "2026-10-19", privacy: "2026-10-19" }])
    expect(await host.termsCheck!()).toBeUndefined()
    expect(idp.cloud.state.termsPuts).toHaveLength(1)
    idp.stop()

    // Lunos Cloud records an older version than its current one: asked again, then its versions are sent.
    host = await setup({
      cloud: {
        ...FakeIdp.defaultCloud(),
        terms: { terms: "2026-11-01", privacy: "2026-10-19" },
        accepted: { "u-1": { terms: "2026-10-19", privacy: "2026-10-19" } },
      },
    })
    await host.accept(host.legal.version)
    await signIn(host)
    const check = await host.termsCheck!()
    expect(check).toEqual({
      current: { terms: "2026-11-01", privacy: "2026-10-19" },
      accepted: { terms: "2026-10-19", privacy: "2026-10-19" },
    })
    expect(idp.cloud.state.termsPuts).toEqual([])
    await host.accept(host.legal.version, check!.current)
    expect(idp.cloud.state.termsPuts).toEqual([{ terms: "2026-11-01", privacy: "2026-10-19" }])
    expect(await host.termsCheck!()).toBeUndefined()
    // A version Lunos Cloud doesn't have now is refused there, and that isn't swallowed.
    await expect(host.accept(host.legal.version, { terms: "1999-01-01", privacy: "1999-01-01" })).rejects.toThrow(
      "Accept the current versions",
    )
    idp.stop()

    // Nothing recorded there, and this machine accepted another version: asked, never assumed.
    host = await setup({ cloud: { ...FakeIdp.defaultCloud(), terms: { terms: "2026-12-01", privacy: "2026-12-01" } } })
    await host.accept(host.legal.version)
    await signIn(host)
    expect(await host.termsCheck!()).toEqual({ current: { terms: "2026-12-01", privacy: "2026-12-01" } })
    expect(idp.cloud.state.termsPuts).toEqual([])
  }, 30_000)

  test("refresh: a cached sign-in holds offline; a refused refresh means signed out", async () => {
    const host = await setup()
    expect(await host.refresh()).toBe("none")
    await CloudStore.save({
      issuer: "https://lunos-test-offline.invalid",
      clientID: "lunos-cli",
      tokens: { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_at: 1 },
      sub: "u-1",
      savedAt: new Date().toISOString(),
    })
    expect(await host.refresh()).toBe("ok")
    await CloudStore.save({
      issuer: idp.origin + "/nope",
      clientID: "lunos-cli",
      tokens: { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_at: 1 },
      sub: "u-1",
      savedAt: new Date().toISOString(),
    })
    expect(await host.refresh()).toBe("expired")
  }, 20_000)

  test("LUNOS_TOKEN stands in for a sign-in in CI, can't be refreshed, and logout leaves it alone", async () => {
    await setup()
    process.env.LUNOS_TOKEN = jwt({ sub: "ci-bot", iss: idp.origin, exp: Math.floor(Date.now() / 1000) + 600 })
    const session = await CloudAuth.session("A cloud run")
    expect(session).toMatchObject({ sub: "ci-bot", issuer: idp.origin, fromEnv: true })
    expect(idp.requests).toEqual([])
    process.env.LUNOS_TOKEN = jwt({ sub: "ci-bot", exp: 1 })
    await expect(CloudAuth.session("A cloud run")).rejects.toThrow(/LUNOS_TOKEN has expired/)
    delete process.env.LUNOS_TOKEN
    await expect(CloudAuth.session("A cloud run")).rejects.toThrow(/Run lunos login, or set LUNOS_TOKEN/)
  })
})
