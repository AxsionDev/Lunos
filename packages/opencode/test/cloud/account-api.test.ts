import { afterEach, describe, expect, test } from "bun:test"
import { CloudAccountApi } from "../../src/cloud/account-api"
import { CloudOrgMembers } from "../../src/cloud/org-members"
import * as FakeLunoshq from "./fixtures/fake-lunoshq"

// XCOD-274: the client against lunoshq's contract (fixtures/fake-lunoshq.ts). A route the server
// doesn't have is "not available yet". XCOD-275: a refusal is shown by its `code`, never by its
// message's words; a server that sends no code (or one this client doesn't know) is shown as it says.

let fake: ReturnType<typeof FakeLunoshq.start> | undefined
afterEach(() => fake?.stop())

const token = (sub: string, email: string) => FakeLunoshq.jwt({ sub, email })
const cloud = (options: FakeLunoshq.Options = {}) => {
  fake = FakeLunoshq.start({
    users: { owner: { email: "owner@acme.example" }, pat: { email: "pat@lunos.test" } },
    orgs: { acme: { name: "Acme GmbH", members: { owner: "owner", pat: "member" } } },
    ...options,
  })
  return { endpoint: fake.origin }
}

/** A server that answers every call with `status` and `body` (and `headers`). */
const answering = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  endpoint: "http://127.0.0.1:9",
  fetch: (async () => Response.json(body, { status, headers })) as unknown as typeof fetch,
})
const refused = (status: number, body: unknown, headers?: Record<string, string>) =>
  CloudAccountApi.call("t", "GET", "/v1/x", undefined, "x", answering(status, body, headers)).then(
    (): CloudAccountApi.RefusedError => {
      throw new Error("not refused")
    },
    (e) => e as CloudAccountApi.RefusedError,
  )

describe("refusal codes (XCOD-275 contract)", () => {
  const owners = { owners: [{ sub: "o", email: "owner@acme.example" }] }
  const cases: [string, number, Record<string, unknown> | undefined, string][] = [
    ["not_member", 404, undefined, "You aren't a member of that organisation. Ask one of its owners to invite you."],
    ["owner_required", 403, owners, "Only an organisation owner can do this. Ask: owner@acme.example"],
    ["admin_required", 403, owners, "Only an organisation owner or admin can do this. Ask: owner@acme.example"],
    [
      "last_owner",
      409,
      {
        orgs: [
          { id: "acme", name: "Acme GmbH" },
          { id: "beta", name: "beta" },
        ],
      },
      "You're the only owner of Acme GmbH (acme), beta. Transfer ownership first, with lunos org transfer <member> --org acme, or delete the organisation.",
    ],
    [
      "suspended",
      403,
      undefined,
      "This organisation or account is suspended, so Lunos Cloud refused this. Its owner can ask Lunos support why.",
    ],
    [
      "unverified",
      403,
      undefined,
      "Confirm your e-mail address first: open the link in the e-mail Lunos sent you, then try again.",
    ],
    [
      "break_glass_required",
      403,
      undefined,
      "This needs an active break-glass grant, which only Lunos platform staff can request.",
    ],
    [
      "reauth_required",
      401,
      undefined,
      "This needs a recent sign-in. Sign in again (lunos login, or /login in the TUI), then try again.",
    ],
  ]

  for (const [code, status, details, text] of cases)
    test(`${code}${details ? " with details" : ""}: its own text, whatever the server's words`, async () => {
      // The server's message is deliberately misleading: it must not decide what's shown.
      for (const body of [
        { code, message: "Something else entirely.", ...(details ? { details } : {}) },
        { error: { code, message: "Something else entirely.", ...(details ? { details } : {}) } },
      ]) {
        const error = await refused(status, body)
        expect(error).toBeInstanceOf(CloudAccountApi.RefusedError)
        expect(error).toMatchObject({ status, code, message: text, serverMessage: "Something else entirely." })
      }
    })

  test("lunoshq's body: the top-level code wins over the nested, older one", async () => {
    const error = await refused(403, {
      code: "admin_required",
      message: "Only an organisation owner or admin can do this. Ask: owner@acme.example",
      error: { code: "forbidden", message: "Only an organisation owner or admin can do this. Ask: owner@acme.example" },
    })
    expect(error).toMatchObject({
      code: "admin_required",
      message: "Only an organisation owner or admin can do this. Ask: owner@acme.example",
    })
    const suspended = await refused(403, {
      code: "suspended",
      message: "x",
      details: { scope: "account" },
      error: { code: "account_suspended", message: "x" },
    })
    expect(suspended.code).toBe("suspended")
    expect(suspended.message).toStartWith("This organisation or account is suspended")
  })

  test("owner_required / admin_required without details.owners: the server's message names whom to ask", async () => {
    expect(
      (await refused(403, { code: "owner_required", message: "Only an owner can transfer ownership." })).message,
    ).toBe("Only an owner can transfer ownership.")
    expect((await refused(403, { code: "owner_required" })).message).toBe("Only an organisation owner can do this.")
    expect((await refused(403, { code: "admin_required" })).message).toBe(
      "Only an organisation owner or admin can do this.",
    )
  })

  test("not_found shows the server's message, which names what wasn't found", async () => {
    expect(await refused(404, { code: "not_found", message: "No invitation to acme." })).toMatchObject({
      code: "not_found",
      message: "No invitation to acme.",
    })
  })

  test("a code this client doesn't know, or none (an older server): the server's own message", async () => {
    expect(
      await refused(402, { code: "plan_required", message: "Hybrid workers need the Enterprise plan." }),
    ).toMatchObject({ code: "plan_required", message: "Hybrid workers need the Enterprise plan." })
    expect(await refused(403, { error: { message: "Only an owner can do this. Ask: o@x" } })).toMatchObject({
      code: undefined,
      message: "Only an owner can do this. Ask: o@x",
    })
    expect(await refused(500, "not json")).toMatchObject({ message: "Lunos Cloud answered 500" })
  })

  test("codes from before XCOD-275 that mean the same are shown the same", async () => {
    expect((await refused(403, { error: { code: "org_suspended", message: "x" } })).message).toStartWith(
      "This organisation or account is suspended",
    )
    expect((await refused(403, { error: { code: "account_suspended", message: "x" } })).message).toStartWith(
      "This organisation or account is suspended",
    )
    expect((await refused(403, { error: { code: "email_unverified", message: "x" } })).message).toStartWith(
      "Confirm your e-mail address first",
    )
  })

  test("429: when to try again, from Retry-After or details.retryAfter, in words that fit the wait", async () => {
    expect(await refused(429, { code: "rate_limited", message: "x" }, { "retry-after": "42" })).toMatchObject({
      retryAfter: 42,
      message: "Too many requests. Try again in 42 seconds.",
    })
    expect((await refused(429, { code: "rate_limited", details: { retryAfterSeconds: 90 } })).message).toBe(
      "Too many requests. Try again in 2 minutes.",
    )
    expect((await refused(429, {}, { "retry-after": "7200" })).message).toBe("Too many requests. Try again in 2 hours.")
    expect((await refused(429, {})).message).toBe("Too many requests. Try again later.")
    expect(CloudAccountApi.wait(1)).toBe("1 second")
    expect(CloudAccountApi.wait(60)).toBe("1 minute")
  })

  test("a route the server doesn't have: not served, never a refusal", async () => {
    const notServed = (status: number, body: unknown) =>
      CloudAccountApi.call("t", "GET", "/v1/x", undefined, "Sending it", answering(status, body)).catch((e) => e)
    expect(await notServed(404, { code: "no_route", message: "Not here." })).toBeInstanceOf(
      CloudAccountApi.NotServedError,
    )
    expect(await notServed(404, { error: { code: "not_found", message: "No such route." } })).toBeInstanceOf(
      CloudAccountApi.NotServedError,
    )
    expect(await notServed(404, { code: "not_found", message: "No such route." })).toBeInstanceOf(
      CloudAccountApi.NotServedError,
    )
    expect(await notServed(405, { code: "method_not_allowed", message: "x" })).toBeInstanceOf(
      CloudAccountApi.NotServedError,
    )
  })
})

test("a stranger to an organisation: not_member; a route the server doesn't have: not served", async () => {
  const opts = cloud({ without: ["deletion"] })
  const stranger = token("eve", "eve@evil.example")
  const refusal = await CloudOrgMembers.owners(stranger, "acme", opts).catch((error) => error)
  expect(refusal).toBeInstanceOf(CloudAccountApi.RefusedError)
  expect(refusal).toMatchObject({ status: 404, code: "not_member" })
  const missing = await CloudAccountApi.call(
    stranger,
    "POST",
    "/v1/account/deletion",
    undefined,
    "Deleting your account",
    opts,
  ).catch((error) => error)
  expect(missing).toBeInstanceOf(CloudAccountApi.NotServedError)
  const method = await CloudAccountApi.call(stranger, "PATCH", "/v1/orgs/acme/owners", undefined, "x", opts).catch(
    (e) => e,
  )
  expect(method).toBeInstanceOf(CloudAccountApi.NotServedError)
})

test("an Admin's Owner-only call: owner_required, naming whom to ask", async () => {
  const opts = cloud({ orgs: { acme: { name: "Acme GmbH", members: { owner: "owner", pat: "admin" } } } })
  const pat = token("pat", "pat@lunos.test")
  const transfer = await CloudOrgMembers.transfer(pat, "acme", "pat@lunos.test", "member", opts).catch((e) => e)
  expect(transfer).toMatchObject({
    status: 403,
    code: "owner_required",
    message: "Only an organisation owner can do this. Ask: owner@acme.example",
  })
  const promote = await CloudOrgMembers.setRole(pat, "acme", "owner", "member", opts).catch((e) => e)
  expect(promote).toMatchObject({ code: "owner_required" })
  // What an Admin may do still works.
  expect((await CloudOrgMembers.members(pat, "acme", opts)).members.map((m) => m.role)).toEqual(["owner", "admin"])
})

test("lunoshq #13 (no XCOD-275 codes): a Member's refusal is shown in the server's words", async () => {
  const opts = cloud({ legacy: true })
  const pat = token("pat", "pat@lunos.test")
  const refusal = await CloudOrgMembers.transfer(pat, "acme", "pat@lunos.test", "member", opts).catch((e) => e)
  expect(refusal).toMatchObject({
    status: 403,
    code: "forbidden",
    message: "Only an organisation owner can do this. Ask: owner@acme.example",
  })
  const members = await CloudOrgMembers.members(pat, "acme", opts).catch((e) => e)
  expect(members.message).toBe("Only an organisation owner or admin can do this. Ask: owner@acme.example")
  const stranger = await CloudOrgMembers.owners(token("eve", "e@x"), "acme", opts).catch((e) => e)
  expect(stranger).toMatchObject({ code: "not_found", message: "No organisation acme." })
})

test("account: platform role, organisations, terms, plan; deletion refused for the last owner, named", async () => {
  const opts = cloud({
    users: { owner: { email: "owner@acme.example", platformRole: "global_admin" } },
    plans: { owner: "team" },
    planSources: { owner: "acme" },
  })
  const owner = token("owner", "owner@acme.example")
  const account = await CloudAccountApi.account(owner, opts)
  expect(account).toMatchObject({
    platformRole: "global_admin",
    organizations: [{ org: "acme", name: "Acme GmbH", role: "owner" }],
    terms: { current: { terms: "2026-10-19", privacy: "2026-10-19" }, needsAcceptance: true },
    plan: "team",
    planSource: "acme",
  })
  expect(account.deletion).toBeUndefined()
  const refusal = await CloudAccountApi.deleteAccount(owner, opts).catch((e) => e)
  expect(refusal).toBeInstanceOf(CloudAccountApi.LastOwnerError)
  expect(refusal.orgs).toEqual([{ id: "acme", name: "Acme GmbH" }])
  expect(fake!.requests.some((r) => r.path.includes("billing"))).toBe(false)
})

test("lunoshq #13: no plan in the account, and last_owner's ids only in the message (fallback)", async () => {
  const opts = cloud({ legacy: true })
  const owner = token("owner", "owner@acme.example")
  expect((await CloudAccountApi.account(owner, opts)).plan).toBeUndefined()
  const refusal = await CloudAccountApi.deleteAccount(owner, opts).catch((e) => e)
  expect(refusal).toBeInstanceOf(CloudAccountApi.LastOwnerError)
  expect(refusal.orgs).toEqual([{ id: "acme", name: "acme" }])
})
