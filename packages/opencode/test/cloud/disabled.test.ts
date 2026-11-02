import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { disabledLines, disabledNotice } from "@opencode-ai/tui/util/account"
import { CloudAccountApi } from "../../src/cloud/account-api"
import { CloudDefaults } from "../../src/cloud/defaults"
import { CloudDisabled } from "../../src/cloud/disabled"
import { CloudHosted } from "../../src/cloud/hosted"
import { CloudStore } from "../../src/cloud/store"
import { CloudTuiHost } from "../../src/cloud/tui-host"
import * as FakeIdp from "./fixtures/fake-idp"

// XCOD-312: a disabled Lunos account, against a fake provider and a fake Lunos Cloud on 127.0.0.1
// with the stand-in keychain: the refusal's parsing, where it is recorded, the three ways a refresh
// can find it, what clears it, and when the session loop refuses a prompt because of it.

const UNTIL = "2026-12-01T00:00:00.000Z"

describe("CloudDisabled.suspension", () => {
  test("an account's suspension, with and without its category and end date", () => {
    expect(
      CloudDisabled.suspension(403, {
        code: "suspended",
        legacyCode: "account_suspended",
        details: { scope: "account", category: "payment", until: UNTIL },
      }),
    ).toEqual({ category: "payment", until: UNTIL })
    expect(CloudDisabled.suspension(403, { code: "suspended", details: { scope: "account" } })).toEqual({})
    // An older server: only the nested code, no details.
    expect(CloudDisabled.suspension(403, { code: "account_suspended" })).toEqual({})
  })

  test("an organisation's suspension, a scope-less `suspended`, and other statuses aren't the account's", () => {
    expect(
      CloudDisabled.suspension(403, {
        code: "suspended",
        legacyCode: "org_suspended",
        details: { scope: "org", category: "abuse" },
      }),
    ).toBeUndefined()
    expect(CloudDisabled.suspension(403, { code: "suspended" })).toBeUndefined()
    expect(CloudDisabled.suspension(402, { code: "suspended", details: { scope: "account" } })).toBeUndefined()
    expect(CloudDisabled.suspension(403, { code: "forbidden", details: { scope: "account" } })).toBeUndefined()
  })

  test("an unknown category and an end date that isn't one are left out", () => {
    expect(
      CloudDisabled.suspension(403, {
        code: "suspended",
        details: { scope: "account", category: "sanctions", until: "soon" },
      }),
    ).toEqual({})
  })

  test("the screen's lines: the category as words, the end date, the support address; never the reason", () => {
    expect(disabledLines({ category: "offboarding", until: UNTIL })).toEqual([
      "Reason: Your organisation offboarded you",
      "Until 2026-12-01",
      "Contact support: support@lunos.tech",
    ])
    expect(disabledLines({})).toEqual(["Contact support: support@lunos.tech"])
    expect(disabledNotice()).toContain("new prompts can't be sent")
  })

  test("a refused refresh says disabled only for invalid_grant with 'disabled' in its description", () => {
    expect(CloudDisabled.refreshSaysDisabled({ code: "invalid_grant", description: "Account disabled" })).toBe(true)
    expect(CloudDisabled.refreshSaysDisabled({ code: "invalid_grant", description: "User disabled" })).toBe(true)
    expect(CloudDisabled.refreshSaysDisabled({ code: "invalid_grant", description: "Session not active" })).toBe(false)
    expect(CloudDisabled.refreshSaysDisabled({ code: "invalid_client", description: "Client disabled" })).toBe(false)
  })
})

describe("a disabled account (XCOD-312)", () => {
  let idp: ReturnType<typeof FakeIdp.start> | undefined
  let dir: string
  const previous = { data: Global.Path.data, config: Global.Path.config, cache: Global.Path.cache }

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-disabled-"))
    process.env.LUNOS_CLOUD_STORE = "test-keychain"
  })
  afterAll(async () => {
    delete process.env.LUNOS_CLOUD_STORE
    await fs.rm(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    delete process.env.LUNOS_TOKEN
    delete process.env.LUNOS_OFFLINE
  })
  afterEach(() => {
    idp?.stop()
    idp = undefined
    delete process.env.LUNOS_OFFLINE
    ;(Global.Path as { data: string }).data = previous.data
    ;(Global.Path as { config: string }).config = previous.config
    ;(Global.Path as { cache: string }).cache = previous.cache
  })

  async function setup(options: FakeIdp.Options = {}) {
    idp = FakeIdp.start(options)
    ;(Global.Path as { data: string }).data = await fs.mkdtemp(path.join(dir, "data-"))
    ;(Global.Path as { config: string }).config = await fs.mkdtemp(path.join(dir, "config-"))
    ;(Global.Path as { cache: string }).cache = await fs.mkdtemp(path.join(dir, "cache-"))
    await fs.writeFile(
      path.join(Global.Path.config, "opencode.json"),
      JSON.stringify({ cloud: { issuer: idp.origin, endpoint: idp.origin } }),
    )
    return CloudTuiHost.create({
      gate: { required: true, issuer: idp.origin },
      issuer: idp.origin,
      clientID: "lunos-cli",
    })
  }

  /** A stored sign-in whose access token is due for a refresh (`expires_at` 10 s away) or already expired. */
  async function signedIn(expiresIn: number) {
    await CloudStore.save({
      issuer: idp!.origin,
      clientID: "lunos-cli",
      tokens: {
        access_token: ["e30", Buffer.from(JSON.stringify({ sub: "u-1" })).toString("base64url"), "s"].join("."),
        refresh_token: "rt-1",
        token_type: "Bearer",
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      },
      email: "pat@lunos.test",
      sub: "u-1",
      savedAt: new Date().toISOString(),
    })
  }

  const accountCalls = () => idp!.requests.filter((request) => request.path === "/v1/account").length

  test("(a) Lunos Cloud says so at sign-in: recorded with its category and end date, never its free text", async () => {
    const host = await setup({ suspended: { scope: "account", category: "payment", until: UNTIL } })
    const pending = await (await host.start({ signup: false })).wait(new AbortController().signal)
    await pending.save()
    expect(await host.disabled!()).toEqual({ category: "payment", until: UNTIL })
    const raw = await fs.readFile(CloudDisabled.file(), "utf8")
    expect(raw).not.toContain("chargeback")
    expect(raw).not.toContain("Free text")
  })

  test("(a) any account call that gets the suspension records it, and says so in its error", async () => {
    await setup({ suspended: { scope: "account", category: "abuse" } })
    const error = await CloudAccountApi.account("token").catch((caught) => caught)
    expect(error).toBeInstanceOf(CloudAccountApi.RefusedError)
    expect(error.message).toBe(
      "Your Lunos account is disabled. Reason: Abuse or misuse of the service. Contact support: support@lunos.tech.",
    )
    expect(await CloudDisabled.load()).toEqual({ category: "abuse" })
  })

  test("(a) an organisation's suspension doesn't disable the account", async () => {
    const host = await setup({ suspended: { scope: "org", category: "abuse" } })
    const error = await CloudAccountApi.account("token").catch((caught) => caught)
    expect(error).toBeInstanceOf(CloudAccountApi.RefusedError)
    expect(error.message).not.toContain("disabled")
    expect(await host.disabled!()).toBeUndefined()
  })

  test("(a) lunos login's hosted-team lookup records it and prints the notice", async () => {
    await setup({ suspended: { scope: "account", category: "terms" } })
    const restore = CloudHosted.useHostForTests(idp!.origin)
    try {
      const outcome = await CloudHosted.afterLogin({
        issuer: CloudDefaults.DEFAULT_ISSUER,
        sub: "u-1",
        tokens: { access_token: "token" },
      })
      expect(outcome).toEqual({ kind: "disabled", disabled: { category: "terms" } })
      expect(CloudHosted.describe(outcome)).toContain("Reason: A breach of the terms of service")
      expect(await CloudDisabled.load()).toEqual({ category: "terms" })
    } finally {
      restore()
    }
  })

  test("(b) a refresh refused with 'Account disabled' is the disabled state, without asking Lunos Cloud", async () => {
    const host = await setup({ refuseRefresh: { error: "invalid_grant", description: "Account disabled" } })
    await signedIn(10)
    expect(await host.refresh()).toBe("disabled")
    expect(await host.disabled!()).toEqual({})
    expect(accountCalls()).toBe(0)
  })

  test("(c) 'Session not active' with a current access token: one GET /v1/account finds the suspension", async () => {
    const host = await setup({
      refuseRefresh: { error: "invalid_grant", description: "Session not active" },
      suspended: { scope: "account", category: "security", until: UNTIL },
    })
    await signedIn(10)
    expect(await host.refresh()).toBe("disabled")
    expect(await host.disabled!()).toEqual({ category: "security", until: UNTIL })
    expect(accountCalls()).toBe(1)
  })

  test("(c) 'Session not active' for an account that isn't suspended stays a plain sign-out", async () => {
    const host = await setup({ refuseRefresh: { error: "invalid_grant", description: "Session not active" } })
    await signedIn(10)
    expect(await host.refresh()).toBe("expired")
    expect(await host.disabled!()).toBeUndefined()
    expect(accountCalls()).toBe(1)
  })

  test("(c) no probe with an expired access token, or offline", async () => {
    const host = await setup({
      refuseRefresh: { error: "invalid_grant", description: "Offline user session not found" },
      suspended: { scope: "account" },
    })
    await signedIn(-60)
    expect(await host.refresh()).toBe("expired")
    expect(accountCalls()).toBe(0)
    await signedIn(10)
    process.env.LUNOS_OFFLINE = "1"
    await host.refresh()
    expect(accountCalls()).toBe(0)
    expect(await host.disabled!()).toBeUndefined()
  })

  test("a refresh that goes through, a new sign-in, and a sign-out each clear the record", async () => {
    const host = await setup()
    await CloudDisabled.record({ category: "other" })
    await signedIn(10)
    expect(await host.refresh()).toBe("ok")
    expect(await host.disabled!()).toBeUndefined()

    await CloudDisabled.record({ category: "other" })
    const pending = await (await host.start({ signup: false })).wait(new AbortController().signal)
    await pending.save()
    expect(await host.disabled!()).toBeUndefined()

    await CloudDisabled.record({ category: "other" })
    await host.logout()
    expect(await host.disabled!()).toBeUndefined()
  })

  test("a refresh that goes through keeps the record while Lunos Cloud still says suspended", async () => {
    const host = await setup({ suspended: { scope: "account", category: "payment" } })
    await CloudDisabled.record({ category: "payment" })
    await signedIn(10)
    expect(await host.refresh()).toBe("ok")
    expect(await host.disabled!()).toEqual({ category: "payment" })
    expect(accountCalls()).toBe(1)
  })

  test("the session loop's refusal: only where this start needs a Lunos account", async () => {
    await setup()
    const required = { LUNOS_AUTH_REQUIRED: "1" }
    expect(await CloudDisabled.refusal(required)).toBeUndefined()
    await CloudDisabled.record({ category: "payment", until: UNTIL })
    const refused = await CloudDisabled.refusal(required)
    expect(refused).toContain("Your Lunos account is disabled, so new prompts can't run.")
    expect(refused).toContain("Reason: A payment issue")
    expect(refused).toContain("Until 2026-12-01")
    expect(refused).toContain("support@lunos.tech")
    // Exemptions (XCOD-273): offline, CI and a build from source never need the account.
    expect(await CloudDisabled.refusal({ ...required, LUNOS_OFFLINE: "1" })).toBeUndefined()
    expect(await CloudDisabled.refusal({ ...required, CI: "true" })).toBeUndefined()
    expect(await CloudDisabled.refusal({})).toBeUndefined()
  })

  test("what the desktop and web app are told (`active`): the record, behind the same exemptions", async () => {
    await setup()
    const required = { LUNOS_AUTH_REQUIRED: "1" }
    expect(await CloudDisabled.active(required)).toBeUndefined()
    await CloudDisabled.record({ category: "terms", until: UNTIL })
    expect(await CloudDisabled.active(required)).toEqual({ category: "terms", until: UNTIL })
    expect(await CloudDisabled.active({ ...required, LUNOS_OFFLINE: "1" })).toBeUndefined()
    expect(await CloudDisabled.active({})).toBeUndefined()
    await CloudDisabled.clear()
    expect(await CloudDisabled.active(required)).toBeUndefined()
  })
})
