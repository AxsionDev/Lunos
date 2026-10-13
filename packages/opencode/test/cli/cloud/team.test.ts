// XCOD-191: lunos share and lunos memory share through the real CLI, against a fake Lunos console on
// a local port. The session is a fake token in the file store (LUNOS_CLOUD_STORE=file, never the
// keychain), inside the isolated home; the console is named only by managed config.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../../lib/cli-process"

function fakeConsole() {
  const received: Array<{ method: string; path: string; auth: string | null; body: any }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined
      received.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body })
      if (req.headers.get("authorization") !== "Bearer fake-token")
        return Response.json({ error: { code: "unauthenticated", message: "Sign in first" } }, { status: 401 })
      if (url.pathname === "/v1/orgs/acme/policy") return new Response(null, { status: 404 })
      if (url.pathname === "/v1/orgs/acme/shares" && req.method === "POST")
        return Response.json(
          {
            id: "abc",
            url: `http://127.0.0.1:${server.port}/orgs/acme/shares/abc`,
            sha256: "x",
            ...(body?.link
              ? { link: { url: `http://127.0.0.1:${server.port}/s/tok`, expiresAt: "2026-10-14T00:00:00.000Z" } }
              : {}),
          },
          { status: 201 },
        )
      if (url.pathname === "/v1/orgs/acme/memory" && req.method === "POST")
        return Response.json(
          { facts: body.facts.map((_: unknown, i: number) => ({ id: `f${i}`, status: "pending", duplicate: false })) },
          { status: 201 },
        )
      return Response.json({ error: { code: "not_found", message: "No such route." } }, { status: 404 })
    },
  })
  return { server, received, base: `http://127.0.0.1:${server.port}` }
}

const setup = (home: string, base: string, user: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
    const managed = path.join(home, "managed")
    await fs.mkdir(managed, { recursive: true })
    await fs.writeFile(
      path.join(managed, "managed.json"),
      JSON.stringify({ cloud: { policy: `${base}/v1/orgs/acme/policy` } }),
    )
    const config = path.join(home, ".config", "opencode")
    await fs.mkdir(config, { recursive: true })
    const log = path.join(home, "audit.log")
    await fs.writeFile(
      path.join(config, "opencode.json"),
      JSON.stringify({ audit: { enabled: true, path: log }, ...user }),
    )
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
    // The member's own project memory: two facts, one of them carrying a secret.
    const ledger = path.join(home, ".opencode", "memory", "graph")
    await fs.mkdir(ledger, { recursive: true })
    const fact = (id: string, text: string) => ({
      id,
      datasetID: "d",
      text,
      provenance: { sessionID: "ses_a", agent: "build", source: "user message", date: "2026-10-01T10:00:00.000Z" },
    })
    await fs.writeFile(
      path.join(ledger, "facts.jsonl"),
      [
        fact("11111111-1111-4111-8111-111111111111", "Staging deploys run from the release branch only"),
        fact("22222222-2222-4222-8222-222222222222", "The CI token is ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      ]
        .map((f) => JSON.stringify(f) + "\n")
        .join(""),
    )
    const plan = path.join(home, "plan.md")
    await fs.writeFile(plan, "# Rollout plan\n\nBehind a flag.\n")
    return { log, plan, env: { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed, LUNOS_CLOUD_STORE: "file" } }
  })

const uploads = (received: Array<{ method: string; path: string }>) =>
  received.filter((r) => r.method === "POST").map((r) => r.path)

describe("lunos share and lunos memory share (subprocess)", () => {
  cliIt.live(
    "off by default: nothing is uploaded; share cloud uploads to the console with the session's token",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = fakeConsole()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        const { plan, env, log } = yield* setup(home, fake.base)

        const off = yield* opencode.spawn(["share", "--artifact", plan], { env })
        expect(off.exitCode).not.toBe(0)
        expect(off.stderr).toContain("lunos settings set share cloud")
        expect(uploads(fake.received)).toEqual([])

        opencode.expectExit(yield* opencode.spawn(["settings", "set", "share", "cloud"], { env }), 0, "settings set")
        const shared = yield* opencode.spawn(["share", "--artifact", plan, "--link", "24"], { env })
        opencode.expectExit(shared, 0, "share")
        expect(shared.stdout).toContain(`Shared with acme: ${fake.base}/orgs/acme/shares/abc`)
        expect(shared.stdout).toContain(`${fake.base}/s/tok`)
        const post = fake.received.find((r) => r.method === "POST")!
        expect(post).toMatchObject({ path: "/v1/orgs/acme/shares", auth: "Bearer fake-token" })
        expect(post.body).toEqual({
          kind: "artifact",
          title: "Rollout plan",
          content: "# Rollout plan\n\nBehind a flag.\n",
          link: { expiresInHours: 24 },
        })
        const audit = (yield* Effect.promise(() => fs.readFile(log, "utf8")))
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
        expect(audit.filter((e) => e.event === "share.upload").map((e) => e.providerID)).toEqual([
          "share:lunos-console",
        ])

        // Neither a session nor a file named: refused before anything else.
        expect((yield* opencode.spawn(["share"], { env })).exitCode).not.toBe(0)
      }),
    120_000,
  )

  cliIt.live(
    "a residency policy that doesn't allow the console's host refuses the upload and records share.denied",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = fakeConsole()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        const { plan, env, log } = yield* setup(home, fake.base, { share: "cloud", residency: { allow: ["eu"] } })
        const denied = yield* opencode.spawn(["share", "--artifact", plan], { env })
        expect(denied.exitCode).not.toBe(0)
        expect(denied.stderr).toContain("blocked by the data-residency policy")
        expect(uploads(fake.received)).toEqual([])
        const audit = (yield* Effect.promise(() => fs.readFile(log, "utf8"))).split("\n").filter(Boolean)
        expect(audit.map((l) => JSON.parse(l)).some((e) => e.event === "share.denied")).toBe(true)
      }),
    120_000,
  )

  cliIt.live(
    "memory share: a preview sends nothing; --yes sends only the named fact; a fact with a secret never leaves",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const fake = fakeConsole()
        yield* Effect.addFinalizer(() => Effect.sync(() => fake.server.stop(true)))
        const { env } = yield* setup(home, fake.base, { share: "cloud" })
        const id = "11111111-1111-4111-8111-111111111111"

        const preview = yield* opencode.spawn(["memory", "share", id], { env })
        opencode.expectExit(preview, 0, "memory share preview")
        expect(preview.stdout).toContain("Nothing was uploaded")
        expect(uploads(fake.received)).toEqual([])

        const secret = yield* opencode.spawn(["memory", "share", "22222222-2222-4222-8222-222222222222", "--yes"], {
          env,
        })
        expect(secret.exitCode).not.toBe(0)
        expect(uploads(fake.received)).toEqual([])

        const shared = yield* opencode.spawn(["memory", "share", id, "--yes"], { env })
        opencode.expectExit(shared, 0, "memory share --yes")
        expect(shared.stdout).toContain("Shared 1 fact(s) with acme for review")
        const post = fake.received.find((r) => r.method === "POST")!
        expect(post.path).toBe("/v1/orgs/acme/memory")
        expect(post.body.facts).toHaveLength(1)
        expect(post.body.facts[0]).toMatchObject({
          id,
          scope: "project",
          text: "Staging deploys run from the release branch only",
          provenance: { sessionID: "ses_a", agent: "build", source: "user message" },
        })
      }),
    120_000,
  )
})
