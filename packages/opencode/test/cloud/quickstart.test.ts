// XCOD-317: `lunos cloud quickstart` as a user runs it: the real CLI in a subprocess, against the fake
// control plane (its account calls and real workers, each a `lunos serve` with the test's fake model).
// The pure parts first, then the happy path to a results branch, then every refusal on the path with
// the next step it names. Nothing here reaches a hosted model, a real control plane or the keychain.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import { Global } from "@opencode-ai/core/global"
import { CloudAccountApi } from "../../src/cloud/account-api"
import { CloudQuickstart } from "../../src/cloud/quickstart"
import { CloudStore } from "../../src/cloud/store"
import { CloudTuiHost } from "../../src/cloud/tui-host"
import { CloudWorkers } from "../../src/cloud/workers"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"
import * as Fake from "./fixtures/fake-control-plane"

const ENTRY = path.join(import.meta.dir, "../../src/index.ts")
const TIMEOUT = 120_000

describe("quickstart's parts", () => {
  test("the account's plan, billing and git tokens, from GET /v1/account", () => {
    const s = CloudQuickstart.status({
      email: "ada@example.test",
      plan: "free",
      billing: { subject: "user:ada" },
      gitCredentials: ["GitHub.com"],
      organizations: [{ org: "acme" }],
    })
    expect(s).toEqual({
      email: "ada@example.test",
      plan: "free",
      billing: true,
      gitHosts: ["github.com"],
      planSource: undefined,
      member: true,
    })
    expect(CloudQuickstart.needsPlan(s)).toBe(true)
    expect(CloudQuickstart.needsPlan({ ...s, plan: "pro" })).toBe(false)
    // Billing off (a development control plane): no plan needed.
    expect(CloudQuickstart.needsPlan(CloudQuickstart.status({ plan: "free", billing: null }))).toBe(false)
  })

  test("the remote's host, as git tokens are keyed; none for a local remote", () => {
    expect(CloudQuickstart.remoteHost("https://github.com/acme/app.git")).toBe("github.com")
    expect(CloudQuickstart.remoteHost("git@GitHub.com:acme/app.git")).toBe("github.com")
    expect(CloudQuickstart.remoteHost("https://git.example.eu:8443/a/b")).toBe("git.example.eu:8443")
    expect(CloudQuickstart.remoteHost("/tmp/remote.git")).toBeUndefined()
    expect(CloudQuickstart.remoteHost("file:///tmp/remote.git")).toBeUndefined()
    expect(CloudQuickstart.localHost("127.0.0.1:3000")).toBe(true)
    expect(CloudQuickstart.localHost("github.com")).toBe(false)
  })

  test("the results branch from run --cloud's line, and where a forge shows it", () => {
    expect(CloudQuickstart.resultsBranch("cloud: finished: results on lunos/cloud/abc123. Fetch them with: …")).toBe(
      "lunos/cloud/abc123",
    )
    expect(
      CloudQuickstart.resultsBranch("cloud: finished: nothing changed, so there's no results branch"),
    ).toBeUndefined()
    expect(CloudQuickstart.branchUrl("https://github.com/lunos-tech/cloud-hello.git", "lunos/cloud/abc")).toBe(
      "https://github.com/lunos-tech/cloud-hello/tree/lunos/cloud/abc",
    )
    expect(CloudQuickstart.branchUrl("git@gitlab.com:g/app.git", "lunos/cloud/abc")).toBe(
      "https://gitlab.com/g/app/-/tree/lunos/cloud/abc",
    )
    expect(CloudQuickstart.branchUrl("https://git.example.eu/a/b", "lunos/cloud/abc")).toBeUndefined()
  })

  test("the safe first task only adds one file", () => {
    expect(CloudQuickstart.SAFE_TASK).toContain("Create a file named LUNOS_CLOUD_HELLO.md")
    expect(CloudQuickstart.SAFE_TASK).toContain("Don't change any other file")
  })
})

// Each refusal on the path, by its code (and `details.reason`), says the next step in plain words.
describe("every refusal on the path names the next step", () => {
  const cases: Array<[string, number, string, Record<string, unknown> | undefined, RegExp]> = [
    ["unverified", 403, "unverified", undefined, /Confirm your e-mail address first/],
    ["not admitted", 403, "not_admitted", undefined, /isn't open to your account yet/],
    ["suspended (Lunos)", 403, "suspended", { scope: "org", org: "acme" }, /suspended.*Lunos support/],
    ["no plan", 402, "spending_cap", { reason: "no_plan" }, /lunos cloud quickstart/],
    ["capacity", 429, "concurrency_limit", { reason: "capacity" }, /Try again in a few minutes/],
    [
      "the plan's concurrency",
      429,
      "concurrency_limit",
      { reason: "plan_concurrency" },
      /too many cloud runs at once for your plan/,
    ],
  ]
  for (const [name, status, code, details, expected] of cases)
    test(`a cloud run refused: ${name}`, async () => {
      const legacy =
        code === "unverified" || code === "not_admitted" ? "forbidden" : code === "suspended" ? "org_suspended" : code
      const fake = await Fake.start({
        fail: { path: "/v1/workers", status, code, legacy, message: "Refused.", details: details ?? {} },
      })
      try {
        const error = await callWorkers(fake.url)
        expect(error).toBeInstanceOf(CloudWorkers.ServiceError)
        // Contract v1's code stays what it was; the stable one is kept beside it.
        expect([error.code, error.stable]).toEqual([legacy, code])
        expect(error.message).toMatch(expected)
      } finally {
        fake.stop()
      }
    })

  test("payment failed (a 402, not a Lunos suspension): the server's words, which name the billing portal", async () => {
    const message =
      "Your last payment failed, so cloud runs are paused until the card is updated in the billing portal."
    const fake = await Fake.start({
      fail: { path: "/v1/workers", status: 402, code: "spending_cap", message, details: { reason: "payment_failed" } },
    })
    try {
      const error = await callWorkers(fake.url)
      expect(error.message).toBe(message)
    } finally {
      fake.stop()
    }
  })

  test("no git token: the host, and the command that stores one", () => {
    expect(CloudQuickstart.noGitToken("github.com")).toContain("lunos cloud git-token set github.com")
    expect(CloudAccountApi.explain("no_git_token")).toContain("lunos cloud git-token set <host>")
  })
})

describe("the TUI's Try Lunos Cloud command (CloudTuiHost.quickstart)", () => {
  test("only signed in, online, with a Lunos Cloud for runs configured; then lunos cloud quickstart for the directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-quickstart-tui-"))
    const previous = { data: Global.Path.data, config: Global.Path.config }
    ;(Global.Path as { data: string }).data = path.join(dir, "data")
    ;(Global.Path as { config: string }).config = path.join(dir, "config")
    process.env.LUNOS_CLOUD_STORE = "file"
    try {
      await fs.mkdir(Global.Path.config, { recursive: true })
      // Signed out: nothing.
      expect(await CloudTuiHost.quickstart("/repo")).toBeUndefined()
      await CloudStore.save({
        issuer: "https://auth.lunos.tech/realms/Lunos",
        clientID: "lunos-cli",
        tokens: { access_token: "t", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
        sub: "ada",
        savedAt: new Date().toISOString(),
      })
      // Signed in to Lunos, but runs have nowhere to go (cloud.endpoint isn't set): nothing.
      expect(await CloudTuiHost.quickstart("/repo")).toBeUndefined()
      await fs.writeFile(
        path.join(Global.Path.config, "opencode.json"),
        JSON.stringify({ cloud: { endpoint: "https://cloud.example.eu" } }),
      )
      const command = await CloudTuiHost.quickstart("/repo")
      expect(command?.argv.slice(-4)).toEqual(["cloud", "quickstart", "--dir", "/repo"])
      // Offline: nothing.
      process.env.LUNOS_OFFLINE = "1"
      expect(await CloudTuiHost.quickstart("/repo")).toBeUndefined()
    } finally {
      delete process.env.LUNOS_OFFLINE
      await CloudStore.clear()
      delete process.env.LUNOS_CLOUD_STORE
      ;(Global.Path as { data: string }).data = previous.data
      ;(Global.Path as { config: string }).config = previous.config
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

/** PUT /v1/workers through CloudWorkers.create, signed in with the fake's token in a throwaway data directory. */
async function callWorkers(endpoint: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-quickstart-store-"))
  const previous = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
  process.env.LUNOS_CLOUD_STORE = "file"
  try {
    await CloudStore.save({
      issuer: `${endpoint}/oidc`,
      clientID: "lunos-cli",
      tokens: { access_token: Fake.TOKEN, token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
      sub: "ada",
      email: "ada@example.test",
      savedAt: new Date().toISOString(),
    })
    return await CloudWorkers.create({
      config: { cloud: { endpoint } },
      repo: { url: "https://github.com/acme/app.git", commit: "a".repeat(40), branch: "main" },
    }).catch((e) => e)
  } finally {
    await CloudStore.clear()
    ;(Global.Path as { data: string }).data = previous
    delete process.env.LUNOS_CLOUD_STORE
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/**
 * A fake control plane with the account calls and real workers, a pushed repository, and the client
 * signed in to it with cloud.endpoint in the user config (quickstart checks the account where runs go).
 */
function setup(input: CliFixture, account: Fake.Options["account"] = {}, extra: Partial<Fake.Options> = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const fake = await Fake.start({
        account,
        serve: ENTRY,
        serveEnv: {
          OPENCODE_PURE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_AUTOCOMPACT: "1",
          OPENCODE_AUTH_CONTENT: "{}",
          ...(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH
            ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH }
            : {}),
        },
        ...extra,
      })
      const store = path.join(input.home, ".local/share/opencode/cloud/session.json")
      await fs.mkdir(path.dirname(store), { recursive: true })
      await fs.writeFile(
        store,
        JSON.stringify({
          issuer: fake.issuer,
          clientID: "lunos-cli",
          tokens: { access_token: Fake.TOKEN, token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
          sub: "ada",
          savedAt: new Date().toISOString(),
        }),
      )
      const user = path.join(input.home, ".config", "opencode")
      await fs.mkdir(user, { recursive: true })
      await fs.writeFile(path.join(user, "opencode.json"), JSON.stringify({ cloud: { endpoint: fake.url } }))
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-quickstart-"))
      const remote = path.join(root, "remote.git")
      const work = path.join(root, "work")
      await $`git init -q --bare -b main ${remote}`.quiet()
      await $`git clone -q ${remote} ${work}`.quiet()
      await fs.writeFile(path.join(work, "hello.py"), "def greet(name):\n    return f'Hello, {name}!'\n")
      await fs.writeFile(path.join(work, ".gitignore"), ".opencode/\n")
      await $`git -C ${work} add -A`.quiet()
      await $`git -C ${work} -c user.email=t@t -c user.name=t commit -qm init`.quiet()
      await $`git -C ${work} push -q origin HEAD:main`.quiet()
      await $`git -C ${work} branch -q --set-upstream-to=origin/main`.quiet()
      const config = JSON.stringify({ ...testProviderConfig(input.llm.url), cloud: { endpoint: fake.url } })
      const env = { LUNOS_CLOUD_STORE: "file", OPENCODE_CONFIG_CONTENT: config, GIT_CONFIG_NOSYSTEM: "1" }
      return { fake, root, remote, work, env }
    }),
    ({ fake, root }) =>
      Effect.promise(async () => {
        fake.stop()
        await fs.rm(root, { recursive: true, force: true })
      }),
  )
}

const quickstart = (work: string, ...rest: string[]) => ["cloud", "quickstart", "--dir", work, "--no-browser", ...rest]

describe("lunos cloud quickstart (XCOD-317)", () => {
  cliIt.live(
    "signed in with a plan: the safe first task runs on Lunos Cloud and its results branch is printed",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, remote, env } = yield* setup(input, { plan: "pro" })
        // The worker's agent does the task: one file, then a word.
        yield* input.llm.tool("write", { filePath: "LUNOS_CLOUD_HELLO.md", content: "# hello\n" })
        yield* input.llm.text("Added LUNOS_CLOUD_HELLO.md.")
        const result = yield* input.opencode.spawn(
          quickstart(work, "--yes", "--cloud-secret", "OPENCODE_CONFIG_CONTENT"),
          {
            timeoutMs: 100_000,
            env,
          },
        )
        input.opencode.expectExit(result, 0)
        expect(result.stdout).toContain("Signed in as ada@example.test")
        expect(result.stdout).toContain("Plan: pro.")
        expect(result.stdout).toContain("no token needed")
        expect(result.stdout).toContain("A safe first task")
        const branch = /Results on (lunos\/cloud\/[a-z0-9]+)/.exec(result.stdout)?.[1]
        expect(branch).toBeDefined()
        expect(
          (yield* Effect.promise(() => $`git -C ${remote} show ${branch!}:LUNOS_CLOUD_HELLO.md`.quiet().text())).trim(),
        ).toBe("# hello")
        // The task sent was the safe one; quickstart asked the account first, then ran.
        expect(JSON.stringify(yield* input.llm.inputs)).toContain("LUNOS_CLOUD_HELLO.md")
        const paths = fake.requests.map((r) => `${r.method} ${r.path}`)
        expect(paths.indexOf("GET /v1/account")).toBeLessThan(paths.findIndex((p) => p.startsWith("PUT /v1/workers/")))
      }),
    TIMEOUT,
  )

  cliIt.live(
    "the user's own task is run instead of the safe one",
    (input) =>
      Effect.gen(function* () {
        const { work, env } = yield* setup(input, { plan: "pro" })
        yield* input.llm.text("nothing to change")
        const result = yield* input.opencode.spawn(
          quickstart(work, "--cloud-secret", "OPENCODE_CONFIG_CONTENT", "explain hello.py"),
          { timeoutMs: 100_000, env },
        )
        input.opencode.expectExit(result, 0)
        expect(result.stdout).not.toContain("A safe first task")
        expect(result.stdout).toContain("there's no results branch")
        expect(JSON.stringify(yield* input.llm.inputs)).toContain("explain hello.py")
      }),
    TIMEOUT,
  )

  cliIt.live(
    "unverified: refused before anything runs, with the next step",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(
          input,
          {},
          {
            fail: {
              path: "/v1/account",
              status: 403,
              code: "unverified",
              legacy: "forbidden",
              message: "Verify your e-mail address.",
              details: {},
            },
          },
        )
        const result = yield* input.opencode.spawn(quickstart(work, "--yes"), { timeoutMs: 60_000, env })
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Confirm your e-mail address first")
        expect(fake.requests.some((r) => r.path.startsWith("/v1/workers"))).toBe(false)
      }),
    TIMEOUT,
  )

  cliIt.live(
    "no plan, no terminal: it says to start the trial, and nothing runs",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(input, { plan: "free" })
        const result = yield* input.opencode.spawn(quickstart(work, "--yes"), { timeoutMs: 60_000, env })
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Cloud runs need a plan: start the 14-day Pro trial")
        expect(fake.requests.some((r) => r.path === "/v1/billing/checkout" || r.path.startsWith("/v1/workers"))).toBe(
          false,
        )
      }),
    TIMEOUT,
  )

  cliIt.live(
    "no git token for the repository's host: it names the host and the command that stores one",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(input, { plan: "pro" })
        // The commit is on the remote; the remote now names GitHub, which needs a token.
        yield* Effect.promise(() => $`git -C ${work} remote set-url origin https://github.com/acme/app.git`.quiet())
        const result = yield* input.opencode.spawn(quickstart(work, "--yes"), { timeoutMs: 60_000, env })
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("none is stored for github.com")
        expect(result.stderr).toContain("lunos cloud git-token set github.com")
        expect(fake.requests.some((r) => r.path.startsWith("/v1/workers"))).toBe(false)
      }),
    TIMEOUT,
  )

  cliIt.live(
    "Lunos Cloud at capacity: the run is refused with a 429, and it says to try again in a few minutes",
    (input) =>
      Effect.gen(function* () {
        const { work, env } = yield* setup(
          input,
          { plan: "pro" },
          {
            fail: {
              path: "/v1/workers",
              status: 429,
              code: "concurrency_limit",
              message: "All 5 standard workers are busy.",
              details: { reason: "capacity" },
            },
          },
        )
        const result = yield* input.opencode.spawn(quickstart(work, "--yes"), { timeoutMs: 60_000, env })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Try again in a few minutes")
      }),
    TIMEOUT,
  )

  cliIt.live(
    "suspended: refused with what the account's record says, before anything runs",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(
          input,
          {},
          {
            fail: {
              path: "/v1/account",
              status: 403,
              code: "suspended",
              legacy: "account_suspended",
              message: "Disabled.",
              details: { scope: "account", category: "payment" },
            },
          },
        )
        const result = yield* input.opencode.spawn(quickstart(work, "--yes"), { timeoutMs: 60_000, env })
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toMatch(/disabled/i)
        expect(result.stderr).toContain("support@lunos.tech")
        expect(fake.requests.some((r) => r.path.startsWith("/v1/workers"))).toBe(false)
      }),
    TIMEOUT,
  )
})
