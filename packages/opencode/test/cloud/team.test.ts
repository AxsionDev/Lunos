// XCOD-191: the client side of the team features. The organisation's console (found only through
// managed `cloud.policy`), its private marketplace as a marketplace source, uploads gated by the
// `share` setting and the residency policy. A fake console on a local port; the session is a fake
// token in the file store (never the keychain).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Audit } from "@opencode-ai/core/audit"
import { Global } from "@opencode-ai/core/global"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { CloudAuth } from "../../src/cloud/auth"
import { CloudOrg } from "../../src/cloud/org"
import { CloudShare } from "../../src/cloud/share"
import {
  NOT_ALLOWED,
  orgMarketplace,
  refreshMarketplaceCache,
  resolveAddedMarketplaces,
  type MarketplaceListDeps,
} from "../../src/marketplace/shared"

let dir: string
let previousData: string
let previousManaged: string | undefined
const seen: Array<{ url: string; auth: string | null; method: string; body?: string }> = []
let server: ReturnType<typeof Bun.serve>
let base: string
/** What the fake console's `GET /v1` answers: a region, a status code, or nothing (404, an older console). */
let consoleSelf: { region?: string } | number | undefined

const manifest = {
  name: "acme",
  owner: { name: "Acme" },
  plugins: [{ name: "acme-lint", source: { type: "npm", package: "@acme/lint", version: "1.0.0" } }],
  mcp: [{ name: "acme-kb", type: "remote", url: "https://kb.acme.example/mcp" }],
  skills: [],
  hooks: [],
}

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-team-")))
  process.env.LUNOS_CLOUD_STORE = "file"
  previousData = Global.Path.data
  ;(Global.Path as { data: string }).data = path.join(dir, "data")
  previousManaged = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = path.join(dir, "managed")
  await fs.mkdir(path.join(dir, "managed"), { recursive: true })
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "GET" ? undefined : await req.text()
      seen.push({ url: url.pathname + url.search, auth: req.headers.get("authorization"), method: req.method, body })
      if (url.pathname === "/elsewhere") return new Response("x")
      if (url.pathname === "/v1/orgs/acme/redirect")
        return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server.port}/elsewhere` } })
      if (req.headers.get("authorization") !== "Bearer fake-token")
        return Response.json({ error: { code: "unauthenticated", message: "Sign in first" } }, { status: 401 })
      if (url.pathname === "/v1") {
        if (consoleSelf === undefined) return Response.json({ error: { code: "not_found" } }, { status: 404 })
        if (typeof consoleSelf === "number") return new Response("down", { status: consoleSelf })
        return Response.json({ api: "1", name: "Acme console", ...consoleSelf })
      }
      if (url.pathname === "/v1/orgs/acme/shares" && req.method === "GET")
        return Response.json({
          org: "acme",
          shares: [
            {
              id: "s1",
              kind: "session",
              title: "Mine",
              createdBy: "tester",
              createdAt: 1,
              links: [{ id: "l1", expiresAt: "2099-01-01T00:00:00.000Z" }],
            },
            { id: "s2", kind: "artifact", title: "Theirs", createdBy: "other", createdAt: 2, links: 0 },
          ],
        })
      if (url.pathname === "/v1/orgs/acme/shares/s1" && req.method === "DELETE")
        return new Response(null, { status: 204 })
      if (url.pathname === "/v1/orgs/acme/marketplace.json") return Response.json(manifest)
      if (url.pathname === "/v1/orgs/acme/plan")
        return Response.json(
          { error: { code: "plan_required", message: "acme: needs the Team plan." } },
          { status: 402 },
        )
      if (url.pathname === "/v1/orgs/acme/shares")
        return Response.json({ id: "s1", url: `${base}/orgs/acme/shares/s1`, sha256: "x" }, { status: 201 })
      return Response.json({ error: { code: "not_found", message: "No such route." } }, { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  server.stop(true)
  ;(Global.Path as { data: string }).data = previousData
  if (previousManaged === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousManaged
  delete process.env.LUNOS_CLOUD_STORE
  await fs.rm(dir, { recursive: true, force: true })
})

afterEach(() => {
  seen.length = 0
  consoleSelf = undefined
})

async function signIn() {
  await fs.mkdir(path.join(dir, "data", "cloud"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "data", "cloud", "session.json"),
    JSON.stringify({
      issuer: "http://127.0.0.1:9/realms/test",
      clientID: "lunos-cli",
      tokens: { access_token: "fake-token", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
      sub: "tester",
      savedAt: new Date().toISOString(),
    }),
  )
}

const signOut = () => fs.rm(path.join(dir, "data", "cloud", "session.json"), { force: true })
const managed = (doc: unknown) => fs.writeFile(path.join(dir, "managed", "managed.json"), JSON.stringify(doc))

describe("CloudOrg: the organisation's console", () => {
  test("only a console policy URL names an organisation", () => {
    expect(CloudOrg.parse("https://console.acme.eu/v1/orgs/acme/policy")).toEqual({
      org: "acme",
      base: "https://console.acme.eu/v1/orgs/acme",
      host: "console.acme.eu",
      api: "https://console.acme.eu/v1",
    })
    expect(CloudOrg.parse("https://cloud.lunos.tech/v1/orgs/acme/policy")?.base).toBe(
      "https://cloud.lunos.tech/v1/orgs/acme",
    )
    expect(CloudOrg.parse("https://console.acme.eu/policy.json")).toBeUndefined()
    expect(CloudOrg.parse(undefined)).toBeUndefined()
  })

  test("found in managed config only; user config can't name it", async () => {
    await managed({})
    expect(await CloudOrg.resolve()).toBeUndefined()
    await managed({ cloud: { policy: `${base}/v1/orgs/acme/policy` } })
    expect((await CloudOrg.resolve())?.org).toBe("acme")
    // Plain http only to this machine (XCOD-238's rule): elsewhere it isn't used at all.
    await managed({ cloud: { policy: "http://console.acme.eu/v1/orgs/acme/policy" } })
    expect(await CloudOrg.resolve()).toBeUndefined()
  })

  test("requests carry the session's token; signed out they fail before anything is sent; redirects are refused", async () => {
    const org = CloudOrg.parse(`${base}/v1/orgs/acme/policy`)!
    await signOut()
    await expect(CloudOrg.request(org, "/marketplace.json", { method: "GET", what: "Test" })).rejects.toBeInstanceOf(
      CloudAuth.SignedOutError,
    )
    expect(seen).toEqual([])
    await signIn()
    const ok = await CloudOrg.request(org, "/marketplace.json", { method: "GET", what: "Test" })
    expect((await ok.json()).name).toBe("acme")
    expect(seen.at(-1)).toMatchObject({ url: "/v1/orgs/acme/marketplace.json", auth: "Bearer fake-token" })
    await expect(CloudOrg.request(org, "/redirect", { method: "GET", what: "Test" })).rejects.toThrow()
    expect(seen.some((s) => s.url === "/elsewhere")).toBe(false)
    const refused = await CloudOrg.request(org, "/plan", { method: "GET", what: "Test" }).catch((e) => e)
    expect(refused).toBeInstanceOf(CloudOrg.ConsoleError)
    expect(refused).toMatchObject({ status: 402, code: "plan_required", message: "acme: needs the Team plan." })
  })
})

describe("the private marketplace as a marketplace source", () => {
  const deps = (input: Partial<MarketplaceListDeps>): MarketplaceListDeps => ({
    exists: async () => false,
    readText: async () => "",
    files: () => [],
    resolve: {
      fetchText: async (url) => {
        throw new Error(`unauthenticated fetch of ${url}`)
      },
      readText: async () => "",
      stat: async () => undefined,
    },
    global: path.join(dir, "cfg"),
    cache: {
      dir: path.join(dir, "cache"),
      mtime: async () => undefined,
      readText: async () => undefined,
      write: async () => {},
    },
    ...input,
  })
  const ctx = () => ({ worktree: dir, directory: dir })

  test("listed first as the org's, fetched with the session's token, not the plain fetch", async () => {
    await managed({ cloud: { policy: `${base}/v1/orgs/acme/policy` } })
    await signIn()
    const resolved = await resolveAddedMarketplaces(ctx(), deps({ org: orgMarketplace }))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ scope: "org", ok: true, source: `${base}/v1/orgs/acme/marketplace.json` })
    expect(resolved[0]!.ok && resolved[0]!.manifest).toBeInstanceOf(Marketplace.Manifest)
    expect(seen.map((s) => [s.url, s.auth])).toEqual([["/v1/orgs/acme/marketplace.json", "Bearer fake-token"]])
    // `marketplace update` goes through the same authenticated fetch.
    expect(
      (await refreshMarketplaceCache(`${base}/v1/orgs/acme/marketplace.json`, deps({ org: orgMarketplace }))).ok,
    ).toBe(true)
  })

  test("a locked allow list that doesn't name it refuses it; one that does lets it through", async () => {
    const source = `${base}/v1/orgs/acme/marketplace.json`
    await signIn()
    const policy = (allow: string[]) => async () => ({ locked: ["marketplace_allow"], allow })
    const refused = await resolveAddedMarketplaces(ctx(), deps({ org: orgMarketplace, policy: policy(["acme/other"]) }))
    expect(refused).toEqual([{ source, ok: false, error: NOT_ALLOWED, scope: "org" }])
    expect(seen).toEqual([])
    const allowed = await resolveAddedMarketplaces(ctx(), deps({ org: orgMarketplace, policy: policy([source]) }))
    expect(allowed[0]).toMatchObject({ scope: "org", ok: true })
  })

  test("signed out: the source says so instead of fetching; the token goes to no other URL", async () => {
    await signOut()
    const resolved = await resolveAddedMarketplaces(ctx(), deps({ org: orgMarketplace }))
    expect(resolved[0]).toMatchObject({ scope: "org", ok: false })
    expect(!resolved[0]!.ok && resolved[0]!.error).toContain("lunos login")
    expect(seen).toEqual([])
    await signIn()
    const org = await orgMarketplace()
    await expect(org!.fetchText(`${base}/elsewhere`)).rejects.toThrow("Refusing to send your sign-in")
    expect(seen).toEqual([])
  })

  test("no cloud.policy in managed config: no org source at all", async () => {
    await managed({})
    expect(await orgMarketplace()).toBeUndefined()
    expect(await resolveAddedMarketplaces(ctx(), deps({ org: orgMarketplace }))).toEqual([])
  })
})

describe("uploads: off by default, residency-gated, audited", () => {
  const org = (host: string) => CloudOrg.parse(`https://${host}/v1/orgs/acme/policy`)!

  test("share disabled (the default) refuses; a locked disabled says it's the organisation's policy", () => {
    expect(() => CloudShare.allowed({ share: "disabled" }, "test")).toThrow("lunos settings set share cloud")
    expect(() => CloudShare.allowed({}, "test")).toThrow(CloudShare.RefusedError)
    expect(() => CloudShare.allowed({ share: "disabled", $locked: ["share"] }, "test")).toThrow(
      "share is set by your organisation's policy",
    )
    expect(() => CloudShare.allowed({ share: "cloud" }, "test")).not.toThrow()
    expect(() => CloudShare.allowed({ share: "manual" }, "test")).not.toThrow()
  })

  test("Lunos Cloud's own host is EU; a self-hosted console needs a declaration; both are audited", async () => {
    const audit = path.join(dir, "audit.log")
    const config = { residency: { allow: ["eu" as const] }, audit: { enabled: true, path: audit } }
    expect(Jurisdiction.lookup(CloudShare.TARGET).region).toBe("eu")

    CloudShare.gate(config, org("cloud.lunos.tech"), "https://cloud.lunos.tech/v1/orgs/acme/shares")
    expect(() =>
      CloudShare.gate(config, org("console.acme.eu"), "https://console.acme.eu/v1/orgs/acme/shares"),
    ).toThrow(/blocked by the data-residency policy/)
    CloudShare.gate(
      {
        ...config,
        residency: { allow: ["eu" as const], endpoints: { [CloudShare.TARGET]: { region: "eu" as const } } },
      },
      org("console.acme.eu"),
      "https://console.acme.eu/v1/orgs/acme/shares",
    )
    await Audit.flush()
    await Bun.sleep(100)
    const events = (await fs.readFile(audit, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(events.map((e) => [e.event, e.providerID, e.host])).toEqual([
      ["share.upload", "share:lunos-console", "cloud.lunos.tech"],
      ["share.denied", "share:lunos-console", "console.acme.eu"],
      ["share.upload", "share:lunos-console", "console.acme.eu"],
    ])
  })

  test("a refused upload sends nothing", async () => {
    await signIn()
    const local = CloudOrg.parse(`${base}/v1/orgs/acme/policy`)!
    await expect(
      CloudShare.upload({ share: "disabled" }, local, { kind: "artifact", title: "t", content: "c" }),
    ).rejects.toBeInstanceOf(CloudShare.RefusedError)
    await expect(
      CloudShare.upload({ share: "cloud", residency: { allow: ["eu"] } }, local, {
        kind: "artifact",
        title: "t",
        content: "c",
      }),
    ).rejects.toThrow(/data-residency/)
    // Only the console's own description was asked for (GET /v1); nothing was uploaded.
    expect(seen.filter((r) => r.method !== "GET")).toEqual([])
    const shared = await CloudShare.upload({ share: "cloud" }, local, {
      kind: "artifact",
      title: "t",
      content: "c",
      linkHours: 2,
    })
    expect(shared.id).toBe("s1")
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({
      kind: "artifact",
      title: "t",
      content: "c",
      link: { expiresInHours: 2 },
    })
  })
})

describe("the console's declared region decides (GET /v1)", () => {
  const local = () => CloudOrg.parse(`${base}/v1/orgs/acme/policy`)!
  const artifact = { kind: "artifact" as const, title: "t", content: "c" }
  const events = async (file: string) => {
    await Audit.flush()
    await Bun.sleep(100)
    return (await fs.readFile(file, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }
  const posts = () => seen.filter((r) => r.method === "POST")

  test("region() reads it with the session's token; none declared (404 or absent) is undefined", async () => {
    await signIn()
    expect(await CloudOrg.region(local())).toBeUndefined()
    consoleSelf = {}
    expect(await CloudOrg.region(local())).toBeUndefined()
    consoleSelf = { region: "eu" }
    expect(await CloudOrg.region(local())).toBe("eu")
    expect(seen.at(-1)).toMatchObject({ url: "/v1", method: "GET", auth: "Bearer fake-token" })
    consoleSelf = { region: "mars" }
    await expect(CloudOrg.region(local())).rejects.toBeInstanceOf(CloudOrg.ConsoleError)
  })

  test("a self-hosted console that declares eu is allowed under an EU-only policy, recorded as declared", async () => {
    await signIn()
    const audit = path.join(dir, "region-eu.log")
    consoleSelf = { region: "eu" }
    const config = { share: "cloud", residency: { allow: ["eu" as const] }, audit: { enabled: true, path: audit } }
    expect((await CloudShare.upload(config, local(), artifact)).id).toBe("s1")
    expect(posts()).toHaveLength(1)
    const upload = (await events(audit)).find((e) => e.event === "share.upload")
    expect(upload).toMatchObject({ providerID: "share:lunos-console", region: "eu", basis: "declared" })
  })

  test("a console that declares us is refused before anything is sent, and recorded as share.denied", async () => {
    await signIn()
    const audit = path.join(dir, "region-us.log")
    consoleSelf = { region: "us" }
    const config = { share: "cloud", residency: { allow: ["eu" as const] }, audit: { enabled: true, path: audit } }
    await expect(CloudShare.upload(config, local(), artifact)).rejects.toThrow(/blocked by the data-residency policy/)
    await expect(CloudShare.facts(config, local(), [{ id: "f" }])).rejects.toBeInstanceOf(CloudShare.RefusedError)
    expect(posts()).toEqual([])
    const denied = (await events(audit)).filter((e) => e.event === "share.denied")
    expect(denied).toHaveLength(2)
    expect(denied[0]).toMatchObject({ region: "us", basis: "declared" })
  })

  test("on cloud.lunos.tech too, the console's own declaration wins over the built-in claim", () => {
    const hosted = CloudOrg.parse("https://cloud.lunos.tech/v1/orgs/acme/policy")!
    const config = { residency: { allow: ["eu" as const], audit: false } }
    expect(() => CloudShare.gate(config, hosted, `${hosted.base}/shares`, "us")).toThrow(/does not allow/)
    CloudShare.gate(config, hosted, `${hosted.base}/shares`, "eu")
    // No declaration: the built-in claim, EU on Lunos Cloud's own host only, as before.
    CloudShare.gate(config, hosted, `${hosted.base}/shares`, undefined)
  })

  test("a residency.endpoints declaration that disagrees with the console is refused", () => {
    const config = {
      residency: {
        allow: ["eu" as const, "us" as const],
        audit: false,
        endpoints: { [CloudShare.TARGET]: { region: "eu" as const } },
      },
    }
    expect(() => CloudShare.gate(config, local(), `${local().base}/shares`, "us")).toThrow(/Correct whichever is wrong/)
    CloudShare.gate(config, local(), `${local().base}/shares`, "eu")
  })

  test("a console that can't be asked: an enforcing policy refuses (share.denied); audit-only goes on", async () => {
    await signIn()
    const audit = path.join(dir, "region-down.log")
    consoleSelf = 500
    const enforcing = { share: "cloud", residency: { allow: ["eu" as const] }, audit: { enabled: true, path: audit } }
    await expect(CloudShare.upload(enforcing, local(), artifact)).rejects.toThrow(/couldn't ask/)
    expect(posts()).toEqual([])
    expect((await events(audit)).some((e) => e.event === "share.denied")).toBe(true)
    const auditOnly = { share: "cloud", audit: { enabled: true, path: audit } }
    expect((await CloudShare.upload(auditOnly, local(), artifact)).id).toBe("s1")
  })

  test("no residency policy and no audit log: the console isn't asked", async () => {
    await signIn()
    consoleSelf = { region: "us" }
    await CloudShare.upload({ share: "cloud" }, local(), artifact)
    expect(seen.map((r) => r.url)).toEqual(["/v1/orgs/acme/shares"])
  })

  test("--link with no hours sends none, so the console's default (30 days) and maximum apply", async () => {
    await signIn()
    await CloudShare.upload({ share: "cloud" }, local(), { ...artifact, linkHours: true })
    expect(JSON.parse(seen.at(-1)!.body!).link).toEqual({})
  })
})

describe("list and revoke", () => {
  const local = () => CloudOrg.parse(`${base}/v1/orgs/acme/policy`)!

  test("list reads the organisation's shares; revoke deletes one; neither is gated on share", async () => {
    await signIn()
    const shares = await CloudShare.list(local())
    expect(shares.map((s) => s.id)).toEqual(["s1", "s2"])
    await CloudShare.revoke(local(), "s1")
    expect(seen.at(-1)).toMatchObject({ url: "/v1/orgs/acme/shares/s1", method: "DELETE", auth: "Bearer fake-token" })
    const missing = await CloudShare.revoke(local(), "nope").catch((e) => e)
    expect(missing).toBeInstanceOf(CloudOrg.ConsoleError)
  })
})
