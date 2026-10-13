// XCOD-238: the organisation policy fetched from the Lunos console, end to end through the real CLI.
// A fake console on a local port serves the console's response shape; the "session" is a fake token
// in the file store (LUNOS_CLOUD_STORE=file, never the keychain), inside the isolated home.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { ConfigOrgPolicy } from "../../../src/config/org-policy"
import { cliIt } from "../../lib/cli-process"

const POLICY = { $locked: ["share"], share: "disabled" }

function fakeConsole() {
  const seen: { ifNoneMatch: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({ ifNoneMatch: req.headers.get("if-none-match") })
      if (req.headers.get("authorization") !== "Bearer fake-token")
        return Response.json({ error: { code: "unauthenticated" } }, { status: 401 })
      const sha = ConfigOrgPolicy.sha256(POLICY)
      const etag = `"${sha}"`
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
      return Response.json(
        {
          org: "acme",
          version: 1,
          sha256: sha,
          updatedAt: new Date(0).toISOString(),
          locked: ["share"],
          policy: POLICY,
        },
        { headers: { etag } },
      )
    },
  })
  return { server, seen, url: `http://127.0.0.1:${server.port}/v1/orgs/acme/policy` }
}

const setup = (home: string, url: string) =>
  Effect.promise(async () => {
    const managed = path.join(home, "managed")
    await fs.mkdir(managed, { recursive: true })
    await fs.writeFile(path.join(managed, "managed.json"), JSON.stringify({ cloud: { policy: url } }))
    const user = path.join(home, ".config", "opencode")
    await fs.mkdir(user, { recursive: true })
    const log = path.join(home, "audit", "audit.log")
    await fs.writeFile(path.join(user, "opencode.json"), JSON.stringify({ audit: { enabled: true, path: log } }))
    const data = path.join(home, ".local", "share", "opencode")
    await fs.mkdir(path.join(data, "cloud"), { recursive: true })
    await fs.writeFile(
      path.join(data, "cloud", "session.json"),
      JSON.stringify({
        issuer: "http://127.0.0.1:9/realms/test",
        clientID: "lunos-cli",
        tokens: { access_token: "fake-token", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
        sub: "tester",
        savedAt: new Date().toISOString(),
      }),
    )
    return {
      log,
      cache: path.join(data, "cloud", "policy.json"),
      env: { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed, LUNOS_CLOUD_STORE: "file" },
    }
  })

const events = (log: string) =>
  Effect.promise(async () =>
    (await fs.readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  )

describe("organisation policy from the console (subprocess)", () => {
  cliIt.live(
    "a locked key from the fetched policy is enforced and audited; client.start records the policy",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = fakeConsole()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        const { log, env } = yield* setup(home, fake.url)

        const set = yield* opencode.spawn(["settings", "set", "share", "auto"], { env })
        expect(set.exitCode).not.toBe(0)
        expect(set.stdout + set.stderr).toContain("share is set by your organisation's policy")

        const all = yield* events(log)
        const refused = all.filter((e) => e.event === "policy.override_refused")
        expect(refused.map((e) => e.key)).toContain("share")
        const starts = all.filter((e) => e.event === "client.start")
        expect(starts).toHaveLength(1)
        expect(starts[0]).toMatchObject({
          os: process.platform,
          arch: process.arch,
          policy_source: "managed+console",
          policy_fetch: "ok",
          policy_sha256: ConfigOrgPolicy.sha256(POLICY),
          policy_version: 1,
        })
        expect(starts[0]?.policy_digest).toMatch(/^[0-9a-f]{64}$/)

        const sources = yield* opencode.spawn(["debug", "config", "--sources"], { env })
        opencode.expectExit(sources, 0, "debug config --sources")
        const row = sources.stdout.split("\n").find((line) => line.startsWith("share "))
        expect(row).toMatch(/managed\s+locked\s+.*v1\/orgs\/acme\/policy/)
        // The second start asked with the cached ETag.
        expect(fake.seen.at(-1)?.ifNoneMatch).toBe(`"${ConfigOrgPolicy.sha256(POLICY)}"`)
      }),
    90_000,
  )

  cliIt.live(
    "offline, the cached policy still holds; an edited cache can't loosen it while the console is reachable",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = fakeConsole()
        const { log, cache, env } = yield* setup(home, fake.url)
        const share = (result: { stdout: string }) =>
          JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))).share as string

        // First start fetches and caches.
        expect(share(yield* opencode.spawn(["debug", "config"], { env }))).toBe("disabled")

        // Console gone: the cached copy applies.
        fake.server.stop(true)
        expect(share(yield* opencode.spawn(["debug", "config"], { env }))).toBe("disabled")
        const offline = (yield* events(log)).filter((e) => e.event === "client.start").at(-1)
        expect(offline).toMatchObject({ policy_source: "managed+cache", policy_fetch: "unreachable" })

        // A consistently re-hashed edit that unlocks share, then the console is back on the same port.
        const loose = { share: "auto" }
        const sha = ConfigOrgPolicy.sha256(loose)
        const cached = JSON.parse(yield* Effect.promise(() => fs.readFile(cache, "utf8")))
        yield* Effect.promise(() =>
          fs.writeFile(cache, JSON.stringify({ ...cached, policy: loose, sha256: sha, etag: `"${sha}"` })),
        )
        const port = Number(new URL(fake.url).port)
        const back = Bun.serve({ port, hostname: "127.0.0.1", fetch: fake.server.fetch.bind(fake.server) })
        yield* Effect.addFinalizer(() => Effect.sync(() => back.stop(true)))
        expect(share(yield* opencode.spawn(["debug", "config"], { env }))).toBe("disabled")
        const restored = JSON.parse(yield* Effect.promise(() => fs.readFile(cache, "utf8")))
        expect(restored.policy).toEqual(POLICY)

        // Signed out, the cache still holds (signing out isn't a way out).
        yield* Effect.promise(() => fs.rm(path.join(path.dirname(cache), "session.json")))
        expect(share(yield* opencode.spawn(["debug", "config"], { env }))).toBe("disabled")
      }),
    120_000,
  )

  cliIt.live(
    "lunos run writes exactly one client.start; the old console command group is gone",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const fake = fakeConsole()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        const { log, env } = yield* setup(home, fake.url)
        yield* llm.text("hello")
        const run = yield* opencode.run("hi", { env })
        expect(run.stdout + run.stderr).toContain("hello")
        expect((yield* events(log)).filter((e) => e.event === "client.start")).toHaveLength(1)

        const console = yield* opencode.spawn(["console", "login", "http://127.0.0.1:9"], { env })
        expect(console.exitCode).not.toBe(0)
      }),
    90_000,
  )
})
