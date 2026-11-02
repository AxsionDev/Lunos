import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { ConfigOrgPolicy } from "../../src/config/org-policy"

// XCOD-238: the organisation policy from the Lunos console. A fake console on a local port serves
// the console's response shape (`{ org, version, sha256, updatedAt, locked, policy }`, ETag the
// policy's SHA-256). No real sign-in: the access token is injected.

const ORG_POLICY = { $locked: ["share", "residency"], share: "disabled", residency: { allow: ["eu"] } }

type Seen = { authorization: string | null; ifNoneMatch: string | null }
let server: ReturnType<typeof Bun.serve>
let served: Record<string, unknown> = ORG_POLICY
let status = 200
let seen: Seen[] = []
let dir: string
let previous: string

function respond(req: Request) {
  seen.push({ authorization: req.headers.get("authorization"), ifNoneMatch: req.headers.get("if-none-match") })
  if (req.headers.get("authorization") !== "Bearer fake-token")
    return Response.json({ error: { code: "unauthenticated" } }, { status: 401 })
  if (status !== 200) return Response.json({ error: { code: "x" } }, { status })
  const sha = ConfigOrgPolicy.sha256(served)
  const etag = `"${sha}"`
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
  return Response.json(
    {
      org: "acme",
      version: 3,
      sha256: sha,
      updatedAt: new Date().toISOString(),
      locked: served.$locked,
      policy: served,
    },
    { headers: { etag } },
  )
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-org-policy-"))
  previous = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: respond })
})
afterAll(async () => {
  server.stop(true)
  ;(Global.Path as { data: string }).data = previous
  await fs.rm(dir, { recursive: true, force: true })
})
afterEach(async () => {
  served = ORG_POLICY
  status = 200
  seen = []
  ConfigOrgPolicy.reset()
  await fs.rm(ConfigOrgPolicy.cacheFile(), { force: true })
})

const url = () => `http://127.0.0.1:${server.port}/v1/orgs/acme/policy`
const onDisk = () => [{ cloud: { policy: url() } }]
const token = async () => "fake-token"
const signedOut = async () => undefined
const readCacheFile = async () => JSON.parse(await fs.readFile(ConfigOrgPolicy.cacheFile(), "utf8"))

describe("ConfigOrgPolicy.fetchPolicy (XCOD-238)", () => {
  test("fetches with the session's token, caches the policy, and returns it as a managed layer", async () => {
    const result = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    expect(result).toMatchObject({ source: "console", fetch: "ok", version: 3 })
    expect(result.layer).toEqual(ORG_POLICY)
    expect(seen).toEqual([{ authorization: "Bearer fake-token", ifNoneMatch: null }])
    const cache = await readCacheFile()
    expect(cache.sha256).toBe(ConfigOrgPolicy.sha256(ORG_POLICY))
    expect(cache.policy).toEqual(ORG_POLICY)
    if (process.platform !== "win32") expect((await fs.stat(ConfigOrgPolicy.cacheFile())).mode & 0o777).toBe(0o600)
  })

  test("asks again with the cached ETag; a 304 keeps the cached copy", async () => {
    await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    const again = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    expect(seen[1]?.ifNoneMatch).toBe(`"${ConfigOrgPolicy.sha256(ORG_POLICY)}"`)
    expect(again).toMatchObject({ source: "console", fetch: "not_modified" })
    expect(again.layer).toEqual(ORG_POLICY)
  })

  test("a changed policy on the console replaces the cache", async () => {
    await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    served = { $locked: ["share"], share: "manual" }
    const again = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    expect(again).toMatchObject({ source: "console", fetch: "ok" })
    expect((await readCacheFile()).policy).toEqual(served)
  })

  test("offline, signed out, refused or failing: the last cached copy", async () => {
    await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    const offline = await ConfigOrgPolicy.fetchPolicy("http://127.0.0.1:9/v1/orgs/acme/policy", [], { token })
    // A different URL has no cache of its own.
    expect(offline).toMatchObject({ source: "none", fetch: "unreachable" })

    for (const code of [401, 404, 500]) {
      status = code
      const result = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
      expect(result.source).toBe("cache")
      expect(result.layer).toEqual(ORG_POLICY)
    }
    status = 200
    const before = seen.length
    const out = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token: signedOut })
    expect(out).toMatchObject({ source: "cache", fetch: "signed_out" })
    expect(seen.length).toBe(before)
  })

  test("the console unreachable: the cached copy, within the timeout", async () => {
    await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    const hang = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) })
    const hung = `http://127.0.0.1:${hang.port}/v1/orgs/acme/policy`
    const cache = await readCacheFile()
    await fs.writeFile(ConfigOrgPolicy.cacheFile(), JSON.stringify({ ...cache, url: hung }))
    const started = Date.now()
    const result = await ConfigOrgPolicy.fetchPolicy(hung, [], { token, timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toMatchObject({ source: "cache", fetch: "unreachable" })
    hang.stop(true)
  })

  test("an edited cache isn't trusted, and can't loosen the policy while the console is reachable", async () => {
    await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    const cache = await readCacheFile()

    // Edited without fixing the hash: ignored outright, even offline.
    await fs.writeFile(ConfigOrgPolicy.cacheFile(), JSON.stringify({ ...cache, policy: { share: "auto" } }))
    expect(ConfigOrgPolicy.readCache(url())).toBeUndefined()
    status = 500
    expect(await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })).toMatchObject({ source: "none" })

    // Edited and re-hashed consistently: its ETag never matches the console's, which sends the real one.
    status = 200
    const loose = { share: "auto" }
    const sha = ConfigOrgPolicy.sha256(loose)
    await fs.writeFile(
      ConfigOrgPolicy.cacheFile(),
      JSON.stringify({ ...cache, policy: loose, sha256: sha, etag: `"${sha}"` }),
    )
    const result = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    expect(seen.at(-1)?.ifNoneMatch).toBe(`"${sha}"`)
    expect(result).toMatchObject({ source: "console", fetch: "ok" })
    expect(result.layer).toEqual(ORG_POLICY)
    expect((await readCacheFile()).policy).toEqual(ORG_POLICY)
  })

  test("a response whose policy doesn't match its SHA-256, or this version can't load, keeps the cache", async () => {
    await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    const bad = (body: unknown) => async () => Response.json(body)
    const mismatch = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), {
      token,
      fetch: bad({ sha256: "0".repeat(64), policy: { share: "auto" } }) as unknown as typeof fetch,
    })
    expect(mismatch).toMatchObject({ source: "cache", fetch: "invalid" })
    const unloadable = { share: 42 }
    const invalid = await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), {
      token,
      fetch: bad({ sha256: ConfigOrgPolicy.sha256(unloadable), policy: unloadable }) as unknown as typeof fetch,
    })
    expect(invalid).toMatchObject({ source: "cache", fetch: "invalid" })
    expect((await readCacheFile()).policy).toEqual(ORG_POLICY)
  })
})

describe("ConfigOrgPolicy merging and URL (XCOD-238)", () => {
  test("on-disk managed config wins whole on a conflict; lock lists add up", () => {
    const fetched = {
      $locked: ["residency", "share"],
      residency: { allow: ["us"], audit: true },
      share: "disabled",
      autoupdate: "notify",
    }
    const disk = [{ $locked: ["marketplace_allow"], residency: { allow: ["eu"] }, marketplace_allow: [] }]
    const layer = ConfigOrgPolicy.subtract(fetched, disk)
    // The on-disk allow list isn't widened by the fetched one (no array concatenation).
    expect(layer).toEqual({
      $locked: ["residency", "share"],
      residency: { audit: true },
      share: "disabled",
      autoupdate: "notify",
    })
  })

  test("cloud.policy only from on-disk managed config, https or this machine only", () => {
    expect(ConfigOrgPolicy.policyURL([{ cloud: { policy: "https://console.example.eu/v1/orgs/a/policy" } }])).toBe(
      "https://console.example.eu/v1/orgs/a/policy",
    )
    expect(ConfigOrgPolicy.policyURL([{ cloud: { policy: "http://console.example.eu/v1/orgs/a/policy" } }])).toBe(
      undefined,
    )
    expect(ConfigOrgPolicy.policyURL([{ cloud: { policy: "http://localhost:8080/v1/orgs/a/policy" } }])).toBe(
      "http://localhost:8080/v1/orgs/a/policy",
    )
    expect(ConfigOrgPolicy.policyURL([{}])).toBeUndefined()
  })

  test("resolveSync uses the intact cache only, no network", async () => {
    await ConfigOrgPolicy.fetchPolicy(url(), onDisk(), { token })
    const before = seen.length
    expect(ConfigOrgPolicy.resolveSync(onDisk()).layer).toEqual(ORG_POLICY)
    expect(ConfigOrgPolicy.resolveSync([{}])).toEqual({ source: "none" })
    expect(seen.length).toBe(before)
  })

  test("the digest is stable across key order and lock order, and changes with the policy", () => {
    const a = ConfigOrgPolicy.digest([{ $locked: ["b", "a"], x: { q: 1, p: 2 } }])
    const b = ConfigOrgPolicy.digest([{ x: { p: 2, q: 1 }, $locked: ["a", "b"] }])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(ConfigOrgPolicy.digest([{ $locked: ["a"], x: { p: 2, q: 1 } }])).not.toBe(a)
    expect(ConfigOrgPolicy.digest([undefined])).toBeUndefined()
  })

  test("client.start fields name the version, platform, digest and source", () => {
    const fields = ConfigOrgPolicy.startFields(
      { url: url(), source: "cache", fetch: "unreachable", layer: ORG_POLICY, sha256: "abc", version: 3 },
      [{ cloud: { policy: url() } }],
    )
    expect(fields).toMatchObject({
      os: process.platform,
      arch: process.arch,
      policy_source: "managed+cache",
      policy_fetch: "unreachable",
      policy_sha256: "abc",
      policy_version: 3,
    })
    expect(typeof fields.version).toBe("string")
    expect(fields.policy_digest).toBe(ConfigOrgPolicy.digest([ORG_POLICY, { cloud: { policy: url() } }]))
    expect(ConfigOrgPolicy.startFields({ source: "none" }, [])).toMatchObject({ policy_source: "none" })
    expect(ConfigOrgPolicy.startFields({ source: "none" }, []).policy_digest).toBeUndefined()
  })
})
