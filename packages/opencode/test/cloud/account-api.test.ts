import { afterEach, expect, test } from "bun:test"
import { CloudAccountApi } from "../../src/cloud/account-api"
import { CloudOrgMembers } from "../../src/cloud/org-members"
import * as FakeLunoshq from "./fixtures/fake-lunoshq"

// XCOD-274: the client against lunoshq #13's contract (fixtures/fake-lunoshq.ts). A route the server
// doesn't have is "not available yet"; every other refusal is shown in the server's own words.

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

test('a 404 that answers (not a member) is a refusal; lunoshq\'s "No such route." means not served', async () => {
  const opts = cloud({ without: ["deletion"] })
  const stranger = token("eve", "eve@evil.example")
  const refused = await CloudOrgMembers.owners(stranger, "acme", opts).catch((error) => error)
  expect(refused).toBeInstanceOf(CloudAccountApi.RefusedError)
  expect(refused).toMatchObject({ status: 404, code: "not_found", message: "No organisation acme." })
  const missing = await CloudAccountApi.call(
    stranger,
    "POST",
    "/v1/account/deletion",
    undefined,
    "Deleting your account",
    opts,
  ).catch((error) => error)
  expect(missing).toBeInstanceOf(CloudAccountApi.NotServedError)
  // 405 "Not here." is a route that doesn't take that method: not served either.
  const method = await CloudAccountApi.call(stranger, "PATCH", "/v1/orgs/acme/owners", undefined, "x", opts).catch(
    (e) => e,
  )
  expect(method).toBeInstanceOf(CloudAccountApi.NotServedError)
})

test("a Member's Owner-only call: 403 with whom to ask, as the server says it", async () => {
  const opts = cloud()
  const pat = token("pat", "pat@lunos.test")
  const refused = await CloudOrgMembers.transfer(pat, "acme", "pat@lunos.test", "member", opts).catch((e) => e)
  expect(refused).toMatchObject({
    status: 403,
    code: "forbidden",
    message: "Only an organisation owner can do this. Ask: owner@acme.example",
  })
  const members = await CloudOrgMembers.members(pat, "acme", opts).catch((e) => e)
  expect(members.message).toBe("Only an organisation owner or admin can do this. Ask: owner@acme.example")
})

test("account: platform role, organisations with names, terms; deletion refused for the last owner", async () => {
  const opts = cloud({ users: { owner: { email: "owner@acme.example", platformRole: "global_admin" } } })
  const owner = token("owner", "owner@acme.example")
  const account = await CloudAccountApi.account(owner, opts)
  expect(account).toMatchObject({
    platformRole: "global_admin",
    organizations: [{ org: "acme", name: "Acme GmbH", role: "owner" }],
    terms: { current: { terms: "2026-10-19", privacy: "2026-10-19" }, needsAcceptance: true },
    billingSubject: "user:owner",
  })
  expect(account.deletion).toBeUndefined()
  const refused = await CloudAccountApi.deleteAccount(owner, opts).catch((e) => e)
  expect(refused).toBeInstanceOf(CloudAccountApi.LastOwnerError)
  expect(refused.orgs).toEqual(["acme"])
  expect(await CloudAccountApi.plan(owner, opts)).toBe("free")
})
