// XCOD-243: `lunos cloud git-token`. Unit tests of the module against a recording fake control plane,
// then the real CLI as a subprocess (throwaway HOME and XDG dirs, file session store, a local fake):
// the token goes in the request body only, never in argv, a URL or the command's output.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { CloudDefaults } from "../../src/cloud/defaults"
import { CloudGitToken } from "../../src/cloud/git-token"

const TOKEN = "ghp_cli_secret_0123456789abcdef"
const seen: Array<{ method: string; path: string; auth: string | null; body: string }> = []
let server: ReturnType<typeof Bun.serve>
let base: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      })
      const host = decodeURIComponent(url.pathname.split("/").pop()!)
      if (host === "git.internal.example")
        return Response.json(
          { error: { code: "forbidden", message: "Lunos Cloud doesn't clone from git.internal.example." } },
          { status: 403 },
        )
      return new Response(null, { status: 204 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

const lunos = { token: "access-token", issuer: CloudDefaults.DEFAULT_ISSUER }

describe("CloudGitToken (XCOD-243)", () => {
  test("set: PUT with the token in the body only; the host is normalised", async () => {
    seen.length = 0
    expect(
      await CloudGitToken.set({ host: " GitHub.com ", token: `${TOKEN}\n` }, { session: lunos, endpoint: base }),
    ).toEqual({
      host: "github.com",
      base,
    })
    expect(seen).toEqual([
      {
        method: "PUT",
        path: "/v1/account/git-credentials/github.com",
        auth: "Bearer access-token",
        body: JSON.stringify({ token: TOKEN }),
      },
    ])
    await CloudGitToken.set(
      { host: "gitlab.example.eu:8443", token: TOKEN, username: "ada" },
      { session: lunos, endpoint: base },
    )
    expect(seen[1]).toMatchObject({
      path: "/v1/account/git-credentials/gitlab.example.eu%3A8443",
      body: JSON.stringify({ token: TOKEN, username: "ada" }),
    })
  })

  test("rm: DELETE, no body", async () => {
    seen.length = 0
    await CloudGitToken.remove({ host: "github.com" }, { session: lunos, endpoint: base })
    expect(seen).toEqual([
      { method: "DELETE", path: "/v1/account/git-credentials/github.com", auth: "Bearer access-token", body: "" },
    ])
  })

  test("refuses bad hosts and tokens locally, and passes the control plane's refusal through", async () => {
    seen.length = 0
    for (const host of ["https://github.com", "github.com/acme", "user@github.com", ""])
      await expect(CloudGitToken.set({ host, token: TOKEN }, { session: lunos, endpoint: base })).rejects.toThrow(
        "isn't a host name",
      )
    await expect(
      CloudGitToken.set({ host: "github.com", token: "  " }, { session: lunos, endpoint: base }),
    ).rejects.toThrow("empty")
    await expect(
      CloudGitToken.set({ host: "github.com", token: "a b" }, { session: lunos, endpoint: base }),
    ).rejects.toThrow("spaces")
    expect(seen).toEqual([])
    await expect(
      CloudGitToken.set({ host: "git.internal.example", token: TOKEN }, { session: lunos, endpoint: base }),
    ).rejects.toThrow("doesn't clone from git.internal.example")
  })

  test("an organisation's sign-in isn't sent to Lunos Cloud unless cloud.endpoint is configured", async () => {
    seen.length = 0
    await expect(
      CloudGitToken.set(
        { host: "github.com", token: TOKEN },
        { session: { token: "t", issuer: "https://id.acme.example/realms/acme" } },
      ),
    ).rejects.toThrow("set cloud.endpoint")
    expect(seen).toEqual([])
  })
})

describe("lunos cloud git-token (the real CLI)", () => {
  let home: string
  const entry = path.resolve(import.meta.dir, "../../src/index.ts")

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-gittoken-")))
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

  async function run(args: string[], stdin: string, extra: Record<string, string> = {}) {
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
        ...extra,
      },
      stdin: new Blob([stdin]),
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

  test("set reads the token from stdin, sends it once, and never prints it; rm removes it", async () => {
    seen.length = 0
    const set = await run(["cloud", "git-token", "set", "github.com"], `${TOKEN}\n`)
    expect(set.code).toBe(0)
    expect(set.out).toContain("Saved your git token for github.com on 127.0.0.1")
    expect(set.out + set.err).not.toContain(TOKEN)
    expect(seen).toEqual([
      {
        method: "PUT",
        path: "/v1/account/git-credentials/github.com",
        auth: "Bearer cli-access-token",
        body: JSON.stringify({ token: TOKEN }),
      },
    ])
    const rm = await run(["cloud", "git-token", "rm", "github.com"], "")
    expect([rm.code, rm.out.trim()]).toEqual([
      0,
      "Removed your git token for github.com on 127.0.0.1:" + server.port + ".",
    ])
    expect(seen[1]).toMatchObject({ method: "DELETE", path: "/v1/account/git-credentials/github.com" })
  }, 120_000)

  test("offline, with no token, or refused by the control plane: a clear error and a failing exit code", async () => {
    seen.length = 0
    const offline = await run(["cloud", "git-token", "set", "github.com"], TOKEN, { LUNOS_OFFLINE: "1" })
    expect(offline.code).not.toBe(0)
    expect(offline.out + offline.err).toContain("LUNOS_OFFLINE")
    const empty = await run(["cloud", "git-token", "set", "github.com"], "")
    expect(empty.code).not.toBe(0)
    expect(empty.out + empty.err).toContain("No token given")
    expect(seen).toEqual([])
    const refused = await run(["cloud", "git-token", "set", "git.internal.example"], TOKEN)
    expect(refused.code).not.toBe(0)
    expect(refused.out + refused.err).toContain("doesn't clone from git.internal.example")
    expect(refused.out + refused.err).not.toContain(TOKEN)
  }, 120_000)
})
