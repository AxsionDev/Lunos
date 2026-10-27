// XCOD-318: the private beta's client side. Feedback against a recording fake control plane: with
// the consent box unticked no session data leaves the machine (not the key, not the id anywhere in
// the request); with it ticked the id is sent, and nothing but the whitelisted fields ever is. Then
// `lunos cloud redeem` as the real CLI (throwaway HOME and XDG dirs, file session store, a local
// fake): Lunos Cloud's reason for an expired or used-up code is what the person sees.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { CloudBeta } from "../../src/cloud/beta"
import { CloudDefaults } from "../../src/cloud/defaults"

const SESSION = "ses_7f3a9c2e1b4d5e6f"
const seen: Array<{ method: string; url: string; headers: string; body: string }> = []
let server: ReturnType<typeof Bun.serve>
let base: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.text()
      seen.push({ method: req.method, url: req.url, headers: JSON.stringify([...req.headers]), body })
      if (url.pathname === "/v1/account/feedback")
        return Response.json({ id: "fb-1", sessionShared: JSON.parse(body).sessionId !== undefined }, { status: 201 })
      if (url.pathname === "/v1/account/redeem") {
        const code = JSON.parse(body).code
        if (code === "LUNOS-OLD")
          return Response.json(
            {
              code: "code_expired",
              message: "This beta code expired on 2026-10-01. Ask whoever sent it for a new one.",
              error: { code: "code_expired", message: "…" },
            },
            { status: 410 },
          )
        if (code === "LUNOS-FULL")
          return Response.json(
            {
              code: "code_used_up",
              message: "This beta code has been used as many times as it allows. Ask whoever sent it for a new one.",
            },
            { status: 410 },
          )
        return Response.json({ cohort: "beta-1", plan: { plan: "pro", until: "2026-11-25T09:00:00.000Z" } })
      }
      return Response.json({ code: "no_route", message: "No such route." }, { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

const lunos = { token: "access-token", issuer: CloudDefaults.DEFAULT_ISSUER }

describe("feedback (XCOD-318)", () => {
  test("consent unticked: no session data is sent, anywhere in the request", async () => {
    seen.length = 0
    const result = await CloudBeta.feedback(
      { text: "  The diff view is great.  ", source: "tui", consent: false, sessionId: SESSION },
      { session: lunos, endpoint: base },
    )
    expect(result).toEqual({ id: "fb-1", sessionShared: false })
    expect(seen).toHaveLength(1)
    const sent = seen[0]!
    expect([sent.method, new URL(sent.url).pathname]).toEqual(["POST", "/v1/account/feedback"])
    for (const part of [sent.url, sent.headers, sent.body]) {
      expect(part).not.toContain(SESSION)
      expect(part).not.toContain("sessionId")
    }
    const body = JSON.parse(sent.body)
    expect(Object.keys(body).sort()).toEqual(["consent", "os", "source", "text", "version"])
    expect(body).toMatchObject({
      text: "The diff view is great.",
      source: "tui",
      consent: false,
      os: `${process.platform} ${process.arch}`,
    })
  })

  test("consent ticked: the session id goes with it, and still only the whitelisted fields", async () => {
    seen.length = 0
    const input = {
      text: "Crash",
      source: "app",
      consent: true,
      sessionId: SESSION,
      version: "1.19.2",
      os: "web",
      screenshot: { type: "image/png", data: "iVBORw0KGgo=" },
    } as const
    // Anything else on the input (a transcript, messages) is never sent.
    await CloudBeta.feedback(
      { ...input, ...({ transcript: "TRANSCRIPT", messages: ["MSG"] } as object) },
      { session: lunos, endpoint: base },
    )
    const body = JSON.parse(seen[0]!.body)
    expect(body).toEqual({
      text: "Crash",
      source: "app",
      version: "1.19.2",
      os: "web",
      consent: true,
      sessionId: SESSION,
      screenshot: { type: "image/png", data: "iVBORw0KGgo=" },
    })
    expect(seen[0]!.body).not.toContain("TRANSCRIPT")
    expect(seen[0]!.body).not.toContain("MSG")
  })

  test("nothing to say, offline, or an organisation's sign-in: nothing is sent", async () => {
    seen.length = 0
    await expect(
      CloudBeta.feedback({ text: "  ", source: "cli", consent: false }, { session: lunos, endpoint: base }),
    ).rejects.toThrow("Write what")
    await expect(
      CloudBeta.feedback(
        { text: "hi", source: "cli", consent: false },
        { session: { token: "t", issuer: "https://id.acme.example/realms/acme" } },
      ),
    ).rejects.toThrow("needs a Lunos account")
    const before = process.env.LUNOS_OFFLINE
    process.env.LUNOS_OFFLINE = "1"
    try {
      await expect(
        CloudBeta.feedback({ text: "hi", source: "cli", consent: false }, { session: lunos, endpoint: base }),
      ).rejects.toThrow("offline")
    } finally {
      if (before === undefined) delete process.env.LUNOS_OFFLINE
      else process.env.LUNOS_OFFLINE = before
    }
    expect(seen).toEqual([])
  })
})

describe("lunos cloud redeem (the real CLI)", () => {
  let home: string
  const entry = path.resolve(import.meta.dir, "../../src/index.ts")

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-redeem-")))
    const data = path.join(home, ".local/share/opencode/cloud")
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(
      path.join(data, "session.json"),
      JSON.stringify({
        issuer: CloudDefaults.DEFAULT_ISSUER,
        clientID: "lunos-cli",
        tokens: {
          access_token: "cli-access-token",
          token_type: "Bearer",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
        sub: "ada",
        savedAt: new Date().toISOString(),
      }),
    )
    const config = path.join(home, ".config/opencode")
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(path.join(config, "opencode.json"), JSON.stringify({ cloud: { endpoint: base } }))
  })

  afterAll(() => fs.rm(home, { recursive: true, force: true }))

  async function run(args: string[]) {
    const proc = Bun.spawn(["bun", "run", entry, ...args], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        LUNOS_CLOUD_STORE: "file",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { out, err, code }
  }

  test("redeems the code with the session's token and says what it gave; expired and used-up codes fail with the reason", async () => {
    seen.length = 0
    const ok = await run(["cloud", "redeem", "LUNOS-7K2M-AAAA"])
    expect(ok.code).toBe(0)
    expect(ok.out.trim()).toBe("You're in the Lunos Cloud beta. Lunos Pro is yours until 2026-11-25.")
    expect(seen.map((s) => [s.method, new URL(s.url).pathname, JSON.parse(s.body)])).toEqual([
      ["POST", "/v1/account/redeem", { code: "LUNOS-7K2M-AAAA" }],
    ])
    expect(seen[0]!.headers).toContain("Bearer cli-access-token")

    const expired = await run(["cloud", "redeem", "LUNOS-OLD"])
    expect(expired.code).not.toBe(0)
    expect(expired.out + expired.err).toContain("This beta code expired on 2026-10-01")
    const full = await run(["cloud", "redeem", "LUNOS-FULL"])
    expect(full.code).not.toBe(0)
    expect(full.out + full.err).toContain("used as many times as it allows")
  }, 120_000)
})
