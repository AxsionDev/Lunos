import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Offline } from "@opencode-ai/core/offline"
import { CloudClientStart } from "../../src/cloud/client-start"
import { ConfigOrgPolicy } from "../../src/config/org-policy"

// XCOD-241: client.start to the organisation's console, its off switch, offline mode and the
// "last fetched" notice. A fake console on a local port records every request; the token is
// injected, so nothing here signs in anywhere.

const POLICY = { $locked: ["share"], share: "disabled" }
const PAYLOAD_KEYS = ["arch", "install_id", "os", "policy_digest", "policy_source", "surface", "version"]

type Seen = { method: string; path: string; authorization: string | null; body?: string }
let server: ReturnType<typeof Bun.serve>
let seen: Seen[] = []
let dir: string
let previous: string
const offlineBefore = process.env[Offline.ENV]
const surfaceBefore = process.env.LUNOS_SURFACE

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-client-start-"))
  previous = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.text() : undefined,
      })
      if (url.pathname.endsWith("/clients/start")) return new Response(null, { status: 204 })
      const sha = ConfigOrgPolicy.sha256(POLICY)
      return Response.json({ org: "acme", version: 1, sha256: sha, policy: POLICY }, { headers: { etag: `"${sha}"` } })
    },
  })
})
afterAll(async () => {
  server.stop(true)
  ;(Global.Path as { data: string }).data = previous
  await fs.rm(dir, { recursive: true, force: true })
})
afterEach(async () => {
  seen = []
  ConfigOrgPolicy.reset()
  CloudClientStart.reset()
  if (offlineBefore === undefined) delete process.env[Offline.ENV]
  else process.env[Offline.ENV] = offlineBefore
  if (surfaceBefore === undefined) delete process.env.LUNOS_SURFACE
  else process.env.LUNOS_SURFACE = surfaceBefore
  await fs.rm(path.join(dir, "cloud"), { recursive: true, force: true })
})

const url = () => `http://127.0.0.1:${server.port}/v1/orgs/acme/policy`
const onDisk = () => [{ cloud: { policy: url() } }]
const token = async () => "fake-token"
const posts = () => seen.filter((item) => item.method === "POST")

describe("client.start endpoint", () => {
  test("is the policy URL's organisation, on the same origin", () => {
    expect(CloudClientStart.endpoint("https://console.example.eu/v1/orgs/acme/policy")).toBe(
      "https://console.example.eu/v1/orgs/acme/clients/start",
    )
    expect(CloudClientStart.endpoint("https://console.example.eu/base/v1/orgs/a%20b/policy")).toBe(
      "https://console.example.eu/base/v1/orgs/a%20b/clients/start",
    )
    expect(CloudClientStart.endpoint("https://console.example.eu/policy.json")).toBeUndefined()
    expect(CloudClientStart.endpoint(undefined)).toBeUndefined()
  })
})

describe("cloud.client_start switch", () => {
  test("on by default; the developer's global config turns it off", () => {
    expect(CloudClientStart.enabled({ managed: {}, locked: [], global: {} })).toBe(true)
    expect(CloudClientStart.enabled({ managed: {}, locked: [], global: { cloud: { client_start: false } } })).toBe(
      false,
    )
  })

  test("locked by the organisation (the key or all of cloud), the developer can't turn it off", () => {
    const off = { cloud: { client_start: false } }
    expect(CloudClientStart.enabled({ managed: {}, locked: ["cloud.client_start"], global: off })).toBe(true)
    expect(CloudClientStart.enabled({ managed: { cloud: { policy: url() } }, locked: ["cloud"], global: off })).toBe(
      true,
    )
    // Locking only the sign-in keys leaves the switch to the developer.
    expect(CloudClientStart.enabled({ managed: {}, locked: ["cloud.issuer", "cloud.policy"], global: off })).toBe(false)
  })

  test("a value managed config sets wins either way", () => {
    expect(CloudClientStart.enabled({ managed: { cloud: { client_start: false } }, locked: [], global: {} })).toBe(
      false,
    )
    expect(
      CloudClientStart.enabled({
        managed: { cloud: { client_start: true } },
        locked: [],
        global: { cloud: { client_start: false } },
      }),
    ).toBe(true)
  })
})

describe("client.start", () => {
  test("sends exactly the documented fields, with the session token, once per process", async () => {
    process.env.LUNOS_SURFACE = "run"
    await ConfigOrgPolicy.resolve(onDisk(), { token })
    const input = { managed: onDisk()[0], locked: [], global: {} }
    CloudClientStart.send(input, { token })
    CloudClientStart.send(input, { token })
    await CloudClientStart.flush(5000)
    expect(posts()).toHaveLength(1)
    const post = posts()[0]!
    expect(post.path).toBe("/v1/orgs/acme/clients/start")
    expect(post.authorization).toBe("Bearer fake-token")
    const body = JSON.parse(post.body!) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(PAYLOAD_KEYS)
    expect(body).toMatchObject({
      os: process.platform,
      arch: process.arch,
      surface: "run",
      policy_source: "managed+console",
    })
    expect(body.install_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.policy_digest).toMatch(/^[0-9a-f]{64}$/)
    // Nothing that identifies the machine, the person or the work.
    for (const secret of [os.hostname(), os.userInfo().username, os.homedir(), process.cwd()])
      expect(post.body!).not.toContain(secret)
  })

  test("the install id is generated once and kept", async () => {
    const first = await CloudClientStart.installID()
    expect(await CloudClientStart.installID()).toBe(first)
    expect((await fs.stat(CloudClientStart.idFile())).mode & 0o777).toBe(0o600)
    await fs.writeFile(CloudClientStart.idFile(), "not-an-id")
    const replaced = await CloudClientStart.installID()
    expect(replaced).not.toBe(first)
    expect(await CloudClientStart.installID()).toBe(replaced)
  })

  test("not sent when turned off, or when the console didn't answer this start", async () => {
    await ConfigOrgPolicy.resolve(onDisk(), { token })
    CloudClientStart.send({ managed: {}, locked: [], global: { cloud: { client_start: false } } }, { token })
    await CloudClientStart.flush(2000)
    expect(posts()).toHaveLength(0)

    ConfigOrgPolicy.reset()
    CloudClientStart.reset()
    // A policy URL whose console is down: the policy fetch fails, so no start is sent there either.
    await ConfigOrgPolicy.resolve([{ cloud: { policy: "http://127.0.0.1:9/v1/orgs/acme/policy" } }], { token })
    CloudClientStart.send({ managed: {}, locked: [], global: {} }, { token })
    await CloudClientStart.flush(2000)
    expect(posts()).toHaveLength(0)
  })

  test("a lock keeps it on when the developer turned it off", async () => {
    await ConfigOrgPolicy.resolve(onDisk(), { token })
    CloudClientStart.send(
      { managed: onDisk()[0], locked: ["cloud.client_start"], global: { cloud: { client_start: false } } },
      { token },
    )
    await CloudClientStart.flush(5000)
    expect(posts()).toHaveLength(1)
  })

  test("offline: no request at all, the cached copy applies", async () => {
    // Fetched once online, so there is a cache.
    await ConfigOrgPolicy.resolve(onDisk(), { token })
    ConfigOrgPolicy.reset()
    seen = []
    process.env[Offline.ENV] = "1"
    const result = await ConfigOrgPolicy.resolve(onDisk(), { token })
    expect(result).toMatchObject({ source: "cache", fetch: "offline" })
    expect(result.layer).toEqual(POLICY)
    CloudClientStart.send({ managed: {}, locked: ["cloud.client_start"], global: {} }, { token })
    await CloudClientStart.flush(2000)
    expect(seen).toHaveLength(0)
    expect(ConfigOrgPolicy.notice(result)).toMatch(
      /^Offline mode \(LUNOS_OFFLINE\)\. Using your organisation's policy as last fetched from 127\.0\.0\.1:\d+ at \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/,
    )
  })
})

describe("notice", () => {
  const base = { url: "https://console.example.eu/v1/orgs/acme/policy" }
  test("nothing when the console's copy was confirmed, or with no cloud.policy", () => {
    expect(ConfigOrgPolicy.notice({ ...base, source: "console", fetch: "ok" })).toBeUndefined()
    expect(ConfigOrgPolicy.notice({ ...base, source: "console", fetch: "not_modified" })).toBeUndefined()
    expect(ConfigOrgPolicy.notice({ source: "none" })).toBeUndefined()
  })

  test("the cached copy, with when it was fetched", () => {
    expect(
      ConfigOrgPolicy.notice({
        ...base,
        source: "cache",
        fetch: "unreachable",
        fetchedAt: "2026-10-12T07:05:09.000Z",
      }),
    ).toBe(
      "Couldn't fetch your organisation's policy from console.example.eu: the console couldn't be reached. Using your organisation's policy as last fetched from console.example.eu at 2026-10-12 07:05 UTC.",
    )
    expect(
      ConfigOrgPolicy.notice({ ...base, source: "cache", fetch: "signed_out", fetchedAt: "2026-10-12T07:05:09.000Z" }),
    ).toStartWith("You're not signed in (lunos login). Using your organisation's policy as last fetched")
  })

  test("no cache: says that no organisation policy from the console applies", () => {
    expect(ConfigOrgPolicy.notice({ ...base, source: "none", fetch: "unauthorized" })).toBe(
      "Couldn't fetch your organisation's policy from console.example.eu: the console refused your sign-in. No copy of your organisation's policy from console.example.eu has been fetched yet, so none applies: only managed config on this machine.",
    )
  })
})

describe("surface", () => {
  test("from the command and the caller", () => {
    expect(ConfigOrgPolicy.surfaceFor("", {})).toBe("tui")
    expect(ConfigOrgPolicy.surfaceFor("run", {})).toBe("run")
    expect(ConfigOrgPolicy.surfaceFor("serve", {})).toBe("serve")
    expect(ConfigOrgPolicy.surfaceFor("serve", { OPENCODE_CLIENT: "desktop" })).toBe("desktop")
    expect(ConfigOrgPolicy.surfaceFor("acp", {})).toBe("ide")
    expect(ConfigOrgPolicy.surfaceFor("", { OPENCODE_CALLER: "vscode" })).toBe("ide")
    expect(ConfigOrgPolicy.surfaceFor("debug", {})).toBe("other")
    // An agent's `lunos run` inside the desktop app is still a run.
    expect(ConfigOrgPolicy.surfaceFor("run", { OPENCODE_CLIENT: "desktop" })).toBe("run")
  })

  test("the desktop app's in-process server, which the CLI doesn't start", () => {
    delete process.env.LUNOS_SURFACE
    const client = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = "desktop"
    expect(ConfigOrgPolicy.surface()).toBe("desktop")
    if (client === undefined) delete process.env.OPENCODE_CLIENT
    else process.env.OPENCODE_CLIENT = client
    expect(ConfigOrgPolicy.surface()).toBe(client === "desktop" ? "desktop" : "other")
  })
})
