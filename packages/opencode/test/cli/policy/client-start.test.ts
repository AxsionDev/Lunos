// XCOD-241: client.start to the organisation's console, end to end through the real CLI. A fake
// console (and a fake identity provider) on local ports record every request; the "session" is a
// fake token in the file store (LUNOS_CLOUD_STORE=file, never the keychain), in the isolated home.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ConfigOrgPolicy } from "../../../src/config/org-policy"
import { cliIt } from "../../lib/cli-process"

const POLICY = { $locked: ["share"], share: "disabled" }
const PAYLOAD_KEYS = ["arch", "install_id", "os", "policy_digest", "policy_source", "surface", "version"]

type Seen = { method: string; path: string; authorization: string | null; headers: string; body: string }

function recorder() {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        headers: JSON.stringify([...req.headers.entries()]),
        body: await req.text(),
      })
      if (req.headers.get("authorization") !== "Bearer fake-token")
        return Response.json({ error: { code: "unauthenticated" } }, { status: 401 })
      if (req.method === "POST" && url.pathname === "/v1/orgs/acme/clients/start")
        return new Response(null, { status: 204 })
      if (url.pathname !== "/v1/orgs/acme/policy") return Response.json({}, { status: 404 })
      const sha = ConfigOrgPolicy.sha256(POLICY)
      const etag = `"${sha}"`
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
      return Response.json({ org: "acme", version: 1, sha256: sha, policy: POLICY }, { headers: { etag } })
    },
  })
  return {
    server,
    seen,
    url: `http://127.0.0.1:${server.port}/v1/orgs/acme/policy`,
    posts: () => seen.filter((item) => item.method === "POST"),
    gets: () => seen.filter((item) => item.method === "GET"),
  }
}

type Setup = { managed?: Record<string, unknown>; user?: Record<string, unknown>; issuer?: string; expired?: boolean }

const setup = (home: string, url: string, opts: Setup = {}) =>
  Effect.promise(async () => {
    const managed = path.join(home, "managed")
    await fs.mkdir(managed, { recursive: true })
    await fs.writeFile(
      path.join(managed, "managed.json"),
      JSON.stringify({ ...opts.managed, cloud: { policy: url, ...(opts.managed?.cloud as object) } }),
    )
    const user = path.join(home, ".config", "opencode")
    await fs.mkdir(user, { recursive: true })
    const log = path.join(home, "audit", "audit.log")
    await fs.writeFile(
      path.join(user, "opencode.json"),
      JSON.stringify({ audit: { enabled: true, path: log }, ...opts.user }),
    )
    const data = path.join(home, ".local", "share", "opencode")
    await fs.mkdir(path.join(data, "cloud"), { recursive: true })
    const now = Math.floor(Date.now() / 1000)
    await fs.writeFile(
      path.join(data, "cloud", "session.json"),
      JSON.stringify({
        issuer: opts.issuer ?? "http://127.0.0.1:9/realms/test",
        clientID: "lunos-cli",
        tokens: {
          access_token: "fake-token",
          refresh_token: "fake-refresh",
          token_type: "Bearer",
          // Expired: a start that wants a token would refresh it at the issuer first.
          expires_at: opts.expired ? now - 3600 : now + 3600,
        },
        sub: "tester",
        savedAt: new Date().toISOString(),
      }),
    )
    return {
      log,
      cache: path.join(data, "cloud", "policy.json"),
      idFile: path.join(data, "cloud", "install-id"),
      env: { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed, LUNOS_CLOUD_STORE: "file" } as Record<string, string>,
    }
  })

const events = (log: string) =>
  Effect.promise(async () =>
    (await fs.readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  )

describe("client.start to the organisation's console (subprocess)", () => {
  cliIt.live(
    "lunos run sends exactly the documented fields once, and nothing that identifies the machine or the work",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const fake = recorder()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        const { env, idFile } = yield* setup(home, fake.url)
        yield* llm.text("hello")
        const run = yield* opencode.run("a prompt about secret-project", { env })
        expect(run.stdout + run.stderr).toContain("hello")

        expect(fake.gets()).toHaveLength(1)
        expect(fake.posts()).toHaveLength(1)
        const post = fake.posts()[0]!
        expect(post.path).toBe("/v1/orgs/acme/clients/start")
        expect(post.authorization).toBe("Bearer fake-token")
        const body = JSON.parse(post.body) as Record<string, unknown>
        expect(Object.keys(body).sort()).toEqual(PAYLOAD_KEYS)
        expect(body).toMatchObject({
          os: process.platform,
          arch: process.arch,
          surface: "run",
          policy_source: "managed+console",
        })
        expect(body.policy_digest).toMatch(/^[0-9a-f]{64}$/)
        const id = (yield* Effect.promise(() => fs.readFile(idFile, "utf8"))).trim()
        expect(body.install_id).toBe(id)
        const sent = post.headers + post.body
        for (const forbidden of [home, os.hostname(), os.userInfo().username, "secret-project", "a prompt"])
          expect(sent).not.toContain(forbidden)
        // No "last fetched" notice: the console answered.
        expect(run.stderr).not.toContain("organisation's policy")
      }),
    90_000,
  )

  cliIt.live(
    "turned off in user config: not sent; locked on by the organisation: sent anyway; lunos audit never sends",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = recorder()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        const off = { cloud: { client_start: false } }

        const first = yield* setup(home, fake.url, { user: off })
        opencode.expectExit(yield* opencode.spawn(["debug", "config"], { env: first.env }), 0, "debug config")
        expect(fake.gets().length).toBeGreaterThan(0)
        expect(fake.posts()).toHaveLength(0)

        const locked = yield* setup(home, fake.url, { user: off, managed: { $locked: ["cloud.client_start"] } })
        opencode.expectExit(yield* opencode.spawn(["debug", "config"], { env: locked.env }), 0, "debug config")
        expect(fake.posts()).toHaveLength(1)
        expect(JSON.parse(fake.posts()[0]!.body).surface).toBe("other")

        yield* opencode.spawn(["audit", "verify"], { env: locked.env })
        expect(fake.posts()).toHaveLength(1)
      }),
    120_000,
  )

  cliIt.live(
    "offline: no network call at all (console or identity provider); the cached policy applies and the run says so",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const fake = recorder()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        // Online once, so there is a cached copy.
        const online = yield* setup(home, fake.url)
        opencode.expectExit(yield* opencode.spawn(["debug", "config"], { env: online.env }), 0, "debug config")
        expect(fake.seen.length).toBe(2)
        const fetchedAt = JSON.parse(yield* Effect.promise(() => fs.readFile(online.cache, "utf8"))).fetchedAt as string

        // Offline, with an expired token whose issuer is the recorder too: a refresh would show up.
        fake.seen.length = 0
        const { env, log } = yield* setup(home, fake.url, {
          issuer: fake.url.replace(/\/v1\/.*/, "/realms/x"),
          expired: true,
        })
        const offline = { ...env, LUNOS_OFFLINE: "1" }
        const config = yield* opencode.spawn(["debug", "config"], { env: offline })
        opencode.expectExit(config, 0, "debug config")
        expect(JSON.parse(config.stdout.slice(config.stdout.indexOf("{"))).share).toBe("disabled")
        yield* llm.text("hello")
        const run = yield* opencode.run("hi", { env: offline })
        expect(run.stdout + run.stderr).toContain("hello")
        expect(fake.seen).toHaveLength(0)
        const stamp = new Date(fetchedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"
        expect(run.stderr).toContain(
          `Offline mode (LUNOS_OFFLINE). Using your organisation's policy as last fetched from 127.0.0.1:${fake.server.port} at ${stamp}.`,
        )
        const start = (yield* events(log)).filter((e) => e.event === "client.start").at(-1)
        expect(start).toMatchObject({ policy_source: "managed+cache", policy_fetch: "offline" })
      }),
    120_000,
  )

  cliIt.live(
    "the console down: lunos run says which copy applies and when it was fetched, or that none applies",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const fake = recorder()
        const port = fake.server.port
        const { env, cache } = yield* setup(home, fake.url)
        yield* llm.text("hello")
        yield* llm.text("hello")

        // No cache yet and the console is down: nothing from the console applies.
        fake.server.stop(true)
        const none = yield* opencode.run("hi", { env })
        expect(none.stderr).toContain(
          `Couldn't fetch your organisation's policy from 127.0.0.1:${port}: the console couldn't be reached. No copy of your organisation's policy`,
        )
        expect(none.stderr).toContain("none applies")

        // Back up once (same port), so a copy is cached, then down again.
        const back = Bun.serve({ port, hostname: "127.0.0.1", fetch: fake.server.fetch.bind(fake.server) })
        opencode.expectExit(yield* opencode.spawn(["debug", "config"], { env }), 0, "debug config")
        back.stop(true)
        const fetchedAt = JSON.parse(yield* Effect.promise(() => fs.readFile(cache, "utf8"))).fetchedAt as string
        const stamp = new Date(fetchedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC"
        const cached = yield* opencode.run("hi", { env })
        expect(cached.stderr).toContain(
          `the console couldn't be reached. Using your organisation's policy as last fetched from 127.0.0.1:${port} at ${stamp}.`,
        )
      }),
    150_000,
  )
})
