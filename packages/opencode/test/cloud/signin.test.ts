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

  test("device flow → confirmed → kept in the keychain, with the plan; then /logout", async () => {
    const host = await setup()
    expect(await host.current()).toBeUndefined()
    const flow = await host.start({ signup: true })
    expect(flow.userCode).toBe("WXYZ-2345")
    expect(flow.urlComplete).toContain("user_code=WXYZ-2345")
    expect(flow.expiresAt).toBeGreaterThan(Date.now())
    const pending = await flow.wait(new AbortController().signal)
    expect(pending.verified).toBe(true)
    const user = await pending.save()
    expect(user).toMatchObject({ email: "pat@lunos.test", plan: "Free", kept: "the test keychain" })
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

  test("/account: user, plan, organisations with roles, devices, the platform role; missing parts are named", async () => {
    let host = await setup({ platformRole: "support" })
    await (await (await host.start({ signup: false })).wait(new AbortController().signal)).save()
    const details = await host.details()
    expect(details.user.plan).toBe("Free")
    expect(details.platformRole).toBe("support")
    expect(details.organisations).toEqual([{ org: "acme", role: "admin" }])
    expect(details.devices?.map((d) => [d.name, d.current])).toEqual([
      ["laptop", false],
      ["this", true],
    ])
    expect(details.missing).toEqual([])
    idp.stop()

    host = await setup({ plan: null })
    await (await (await host.start({ signup: false })).wait(new AbortController().signal)).save()
    expect((await host.details()).missing).toEqual(["Plan: Lunos Cloud doesn't report it yet."])
  })

  test("sign out everywhere ends the provider's sessions, then signs out here", async () => {
    const host = await setup()
    await (await (await host.start({ signup: false })).wait(new AbortController().signal)).save()
    expect(await host.logoutEverywhere()).toEqual({ ended: true })
    expect(idp.state.sessionsEnded).toBe(true)
    expect(await host.current()).toBeUndefined()
  })

  test("Delete my account: Lunos Cloud deletes it, and the screen says what's left", async () => {
    let host = await setup()
    await (await (await host.start({ signup: false })).wait(new AbortController().signal)).save()
    const result = await host.deleteAccount()
    expect(idp.state.deleted).toBe(true)
    expect(result.message).toContain("Deleting the sign-in itself isn't available from Lunos Cloud yet")
    expect(await host.current()).toBeUndefined()
    idp.stop()

    host = await setup({ serves: { identityDelete: true } })
    await (await (await host.start({ signup: false })).wait(new AbortController().signal)).save()
    expect((await host.deleteAccount()).message).toBe(
      "Your Lunos account will be deleted within 30 days. You're signed out.",
    )
  })

  test("the accepted Terms version is kept; a new version asks again; consent goes to Lunos Cloud where served", async () => {
    const host = await setup({ serves: { consent: true } })
    expect(needsAcceptance(host.legal, await host.accepted())).toBe(true)
    await host.accept(host.legal.version)
    await (await (await host.start({ signup: true })).wait(new AbortController().signal)).save()
    expect(await host.accepted()).toBe(host.legal.version)
    expect(needsAcceptance(host.legal, await host.accepted())).toBe(false)
    expect(needsAcceptance({ ...host.legal, version: "2099-01-01" }, await host.accepted())).toBe(true)
    expect(idp.state.consent).toEqual([{ terms: host.legal.version, privacy: host.legal.version }])
  })

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
