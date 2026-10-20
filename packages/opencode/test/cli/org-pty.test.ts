import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as FakeLunoshq from "../cloud/fixtures/fake-lunoshq"
import * as Pty from "./fixtures/tui-pty"

// XCOD-274: `lunos org` from source in a pty at 120x45 (and without a terminal, as a script runs it),
// against a fake Lunos Cloud with lunoshq's contract (XCOD-275's refusal codes) on 127.0.0.1. The sign-in is seeded in the
// stand-in keychain; anything else the CLI tries to reach goes to a recording proxy that refuses it.
// Lunos Cloud decides every permission: a Member's Owner-only action is refused there, and shown.

const TIMEOUT = 120_000
const { KEY } = Pty

let proxy: Awaited<ReturnType<typeof Pty.recordingProxy>>
let cloud: ReturnType<typeof FakeLunoshq.start>
let run: Awaited<ReturnType<typeof Pty.launch>> | undefined
const homes: string[] = []

beforeAll(async () => {
  proxy = await Pty.recordingProxy()
})
afterAll(async () => {
  await proxy.close()
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})
afterEach(async () => {
  await run?.stop()
  cloud?.stop()
  run = undefined
  expect(proxy.lunos()).toEqual([])
  proxy.seen.length = 0
})

const USERS: Record<string, FakeLunoshq.User> = {
  olga: { email: "owner@acme.example" },
  pat: { email: "pat@lunos.test" },
  sam: { email: "sam@acme.example" },
  eve: { email: "eve@evil.example" },
}

function start(options: FakeLunoshq.Options = {}) {
  cloud = FakeLunoshq.start({
    users: USERS,
    orgs: {
      acme: { name: "Acme GmbH", members: { olga: "owner", pat: "member", sam: "member" } },
      beta: {
        name: "Beta Ltd",
        members: { olga: "owner" },
        invites: { "pat@lunos.test": { role: "member", invitedBy: "olga", createdAt: Date.now() } },
      },
      gamma: {
        name: "Gamma AG",
        members: { olga: "owner" },
        invites: { "pat@lunos.test": { role: "admin", invitedBy: "olga", createdAt: Date.now() } },
      },
    },
    ...options,
  })
}

/** A HOME signed in as `sub` (the stand-in keychain), with Lunos Cloud at the fake. */
async function signedIn(sub: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-org-pty-"))
  homes.push(home)
  const keychain = path.join(home, ".local/share/opencode/cloud/test-keychain.json")
  await fs.mkdir(path.dirname(keychain), { recursive: true })
  const session = {
    issuer: cloud.origin,
    clientID: "lunos-cli",
    tokens: {
      access_token: FakeLunoshq.jwt({ sub, email: USERS[sub]!.email }),
      token_type: "Bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
    email: USERS[sub]!.email,
    sub,
    savedAt: new Date().toISOString(),
  }
  await fs.writeFile(
    keychain,
    JSON.stringify({ service: "lunos-cloud", account: "default", secret: JSON.stringify(session) }),
  )
  return {
    home,
    config: { cloud: { issuer: cloud.origin, endpoint: cloud.origin } },
    env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url },
  }
}

/** `lunos org …` in the pty; resolves with the screen once the process exits. */
async function org(as: Awaited<ReturnType<typeof signedIn>>, args: string[], answer?: string) {
  run = await Pty.launch({ ...as, args: ["org", ...args] })
  if (answer !== undefined) {
    await run.waitFor("[y/N]")
    await run.type(answer)
    run.press(KEY.enter)
  }
  const until = Date.now() + 60_000
  while (run.exited() === undefined && Date.now() < until) await Bun.sleep(100)
  return { screen: run.screen.text(), code: run.exited() }
}

describe("lunos org (XCOD-274)", () => {
  test(
    "an Owner: members and invitations, invite, revoke (asked), owners add, transfer",
    async () => {
      start()
      const olga = await signedIn("olga")
      // Olga is in three organisations: she chooses one.
      let result = await org(olga, ["members"])
      expect(result.code).toBe(1)
      expect(result.screen).toContain("You're in 3 organisations (acme, beta, gamma). Choose one with --org.")

      result = await org(olga, ["invite", "new@acme.example", "--role", "admin", "--org", "acme"])
      expect(result.code).toBe(0)
      expect(result.screen).toMatch(/Invited new@acme\.example to acme as admin, until \d{4}-\d\d-\d\d\./)

      result = await org(olga, ["members", "--org", "acme"])
      expect(result.code).toBe(0)
      expect(result.screen).toMatch(/Owner\s+owner@acme\.example/)
      expect(result.screen).toMatch(/Member\s+pat@lunos\.test/)
      expect(result.screen).toContain("Invitations:")
      expect(result.screen).toMatch(/Admin\s+new@acme\.example until \d{4}/)

      // Revoking is confirmed at the terminal; "n" changes nothing, "y" revokes.
      result = await org(olga, ["revoke", "new@acme.example", "--org", "acme"], "n")
      expect(result.screen).toContain("Cancelled. Nothing changed.")
      expect(cloud.orgs.acme!.invites!["new@acme.example"]).toBeDefined()
      result = await org(olga, ["revoke", "new@acme.example", "--org", "acme"], "y")
      expect(result.screen).toContain("Revoked the invitation to new@acme.example.")
      expect(cloud.orgs.acme!.invites!["new@acme.example"]).toBeUndefined()

      result = await org(olga, ["owners", "add", "sam@acme.example", "--org", "acme"])
      expect(result.screen).toContain("sam@acme.example is now an owner of acme.")
      expect(cloud.orgs.acme!.members.sam).toBe("owner")

      result = await org(olga, ["transfer", "pat@lunos.test", "--org", "acme", "--yes"])
      expect(result.code).toBe(0)
      expect(result.screen).toContain("pat@lunos.test is now an owner of acme. You're a member.")
      expect(cloud.orgs.acme!.members).toEqual({ olga: "member", pat: "owner", sam: "owner" })

      result = await org(olga, ["owners", "--org", "acme"])
      expect(result.screen).toContain("pat@lunos.test")
      expect(result.screen).toContain("sam@acme.example")
    },
    TIMEOUT,
  )

  test(
    "a Member: every Owner-only action is refused by Lunos Cloud, naming whom to ask",
    async () => {
      start()
      const pat = await signedIn("pat")
      // Pat is only in acme: no --org needed.
      let result = await org(pat, ["members"])
      expect(result.code).toBe(1)
      expect(result.screen).toContain("Only an organisation owner or admin can do this. Ask: owner@acme.example")

      result = await org(pat, ["transfer", "sam@acme.example", "--yes"])
      expect(result.code).toBe(1)
      expect(result.screen).toContain("Only an organisation owner can do this. Ask: owner@acme.example")

      result = await org(pat, ["invite", "friend@example.com"])
      expect(result.code).toBe(1)
      expect(result.screen).toContain("Only an organisation owner or admin can do this. Ask: owner@acme.example")

      // Whom to ask is open to every member.
      result = await org(pat, ["owners"])
      expect(result.code).toBe(0)
      expect(result.screen).toContain("owner@acme.example")
      // Nothing changed, and each refusal came from the server: the client sent the call.
      expect(cloud.orgs.acme!.members).toEqual({ olga: "owner", pat: "member", sam: "member" })
      expect(cloud.requests.filter((r) => r.sub === "pat").map((r) => `${r.method} ${r.path}`)).toContain(
        "POST /v1/orgs/acme/transfer",
      )
    },
    TIMEOUT,
  )

  test(
    "the last Owner can't leave; a stranger is told the organisation isn't theirs",
    async () => {
      start()
      const olga = await signedIn("olga")
      let result = await org(olga, ["leave", "--org", "beta", "--yes"])
      expect(result.code).toBe(1)
      // XCOD-275: last_owner names the organisation from details, not from the message. The line is
      // wider than the pty, so it's read whole from stderr.
      expect(result.screen).toContain("You're the only owner of Beta Ltd (beta).")
      const whole = await Pty.exec(["org", "leave", "--org", "beta", "--yes"], olga)
      expect(whole.stderr.replace(/\s+/g, " ")).toContain(
        "You're the only owner of Beta Ltd (beta). Transfer ownership first, with lunos org transfer <member> --org beta, or delete the organisation.",
      )
      const eve = await signedIn("eve")
      result = await org(eve, ["owners", "--org", "acme"])
      expect(result.code).toBe(1)
      expect(result.screen).toContain("You aren't a member of that organisation. Ask one of its owners to invite you.")
    },
    TIMEOUT,
  )

  test(
    "an Admin (XCOD-275): shown as Admin, manages members, and Owner-only actions say owner_required's text",
    async () => {
      start({
        orgs: { acme: { name: "Acme GmbH", members: { olga: "owner", pat: "admin", sam: "member" } } },
      })
      const pat = await signedIn("pat")
      let result = await org(pat, ["list"])
      expect(result.screen).toMatch(/Admin · Acme GmbH \(acme\)/)
      result = await org(pat, ["members"])
      expect(result.code).toBe(0)
      expect(result.screen).toContain("sam@acme.example")
      result = await org(pat, ["invite", "friend@example.com"])
      expect(result.code).toBe(0)
      for (const [args, text] of [
        [["transfer", "sam@acme.example", "--yes"], "Only an organisation owner can do this. Ask: owner@acme.example"],
        [["owners", "add", "sam@acme.example", "--yes"], "Only an owner can grant or take away ownership."],
        [["invite", "boss@example.com", "--role", "owner"], "Only an owner can invite an owner."],
      ] as const) {
        result = await org(pat, [...args])
        expect(result.code).toBe(1)
        expect(result.screen).toContain(text)
      }
      // Scripts get the code itself.
      const json = await Pty.exec(["org", "transfer", "sam@acme.example", "--yes", "--json"], pat)
      // Scripts that matched "forbidden" keep working for a release: legacyCode.
      expect(JSON.parse(json.stdout).error).toMatchObject({
        status: 403,
        code: "owner_required",
        legacyCode: "forbidden",
      })
      expect(cloud.orgs.acme!.members).toEqual({ olga: "owner", pat: "admin", sam: "member" })
    },
    TIMEOUT,
  )

  test(
    "lunoshq #13 (no XCOD-275 codes): refusals are shown in the server's own words",
    async () => {
      start({ legacy: true })
      const pat = await signedIn("pat")
      let result = await org(pat, ["transfer", "sam@acme.example", "--yes"])
      expect(result.code).toBe(1)
      expect(result.screen).toContain("Only an organisation owner can do this. Ask: owner@acme.example")
      const olga = await signedIn("olga")
      result = await org(olga, ["leave", "--org", "beta", "--yes"])
      expect(result.screen).toContain("An organisation needs at least one owner. Make someone else an owner first.")
    },
    TIMEOUT,
  )

  test(
    "your invitations: listed, accepted and declined",
    async () => {
      start()
      const pat = await signedIn("pat")
      let result = await org(pat, ["invitations"])
      expect(result.screen).toMatch(/Beta Ltd \(beta\) as member until \d{4}/)
      expect(result.screen).toMatch(/Gamma AG \(gamma\) as admin until \d{4}/)
      result = await org(pat, ["accept", "gamma"])
      expect(result.screen).toContain("You joined gamma.")
      result = await org(pat, ["decline", "beta"])
      expect(result.screen).toContain("Declined the invitation to beta.")
      result = await org(pat, ["list"])
      expect(result.screen).toMatch(/Member · Acme GmbH \(acme\)/)
      expect(result.screen).toMatch(/Admin · Gamma AG \(gamma\)/)
      result = await org(pat, ["invitations"])
      expect(result.screen).toContain("No invitations are waiting for you.")
    },
    TIMEOUT,
  )
})

describe("lunos org in a script (XCOD-274)", () => {
  test(
    "--json: results and refusals as JSON; without a terminal, a change needs --yes",
    async () => {
      start()
      const pat = await signedIn("pat")
      let result = await Pty.exec(["org", "list", "--json"], pat)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        organizations: [{ org: "acme", name: "Acme GmbH", role: "member" }],
      })

      result = await Pty.exec(["org", "members", "--json"], pat)
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        error: {
          status: 403,
          code: "admin_required",
          legacyCode: "forbidden",
          message: "Only an organisation owner or admin can do this. Ask: owner@acme.example",
        },
      })

      const olga = await signedIn("olga")
      result = await Pty.exec(["org", "remove", "sam@acme.example", "--org", "acme"], olga)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Remove sam@acme.example from acme? Pass --yes to confirm without a terminal.")
      expect(cloud.orgs.acme!.members.sam).toBe("member")
      result = await Pty.exec(["org", "remove", "sam@acme.example", "--org", "acme", "--yes", "--json"], olga)
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ org: "acme", removed: "sam" })
      expect(cloud.orgs.acme!.members.sam).toBeUndefined()

      // Signed out: says so, and nothing is sent.
      const before = cloud.requests.length
      const signedOut = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-org-pty-"))
      homes.push(signedOut)
      result = await Pty.exec(["org", "list"], {
        home: signedOut,
        env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url },
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Not signed in. Run lunos login.")
      expect(cloud.requests.length).toBe(before)
    },
    TIMEOUT,
  )
})
