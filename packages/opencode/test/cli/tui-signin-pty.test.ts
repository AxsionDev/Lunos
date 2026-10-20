import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as FakeIdp from "../cloud/fixtures/fake-idp"
import * as Pty from "./fixtures/tui-pty"

// XCOD-273: the Welcome screen, the device flow, e-mail confirmation, each error, /login, /logout,
// /account, and every exemption, in the real TUI (from source) in a pty at 120x45. The provider and
// Lunos Cloud are a fake on 127.0.0.1; the keychain is the stand-in one; anything else the TUI tries
// to reach goes to a recording proxy that refuses it, so "no call to a Lunos service" is checked on
// the wire. `LUNOS_AUTH_REQUIRED=1` makes this build from source behave as the official build.

const TIMEOUT = 120_000
const OFFICIAL = { LUNOS_AUTH_REQUIRED: "1" }
const { KEY } = Pty

let proxy: Awaited<ReturnType<typeof Pty.recordingProxy>>
let idp: ReturnType<typeof FakeIdp.start> | undefined
let tui: Awaited<ReturnType<typeof Pty.launch>> | undefined
const homes: string[] = []

beforeAll(async () => {
  proxy = await Pty.recordingProxy()
})
afterAll(async () => {
  await proxy.close()
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})
afterEach(async () => {
  await tui?.stop()
  idp?.stop()
  tui = undefined
  idp = undefined
  proxy.seen.length = 0
})

const proxied = { HTTPS_PROXY: "", HTTP_PROXY: "" }
async function start(options: Pty.Options & { fake?: FakeIdp.Options; signedInWith?: boolean } = {}) {
  if (options.fake || options.config === undefined) idp = FakeIdp.start(options.fake)
  proxied.HTTPS_PROXY = proxy.url
  proxied.HTTP_PROXY = proxy.url
  tui = await Pty.launch({
    ...options,
    config: options.config ?? (idp ? { cloud: { issuer: idp.origin, endpoint: idp.origin } } : undefined),
    env: { ...proxied, ...options.env },
  })
  homes.push(tui.home)
  return tui
}

/** Moves the highlight to the action labelled `label` and chooses it. Actions are the block of rows around "›". */
async function choose(label: string) {
  const screen = tui!.screen.text().split("\n")
  const current = screen.findIndex((line) => /^\s*›\S/.test(line))
  if (current < 0) throw new Error(`No highlighted action. Screen:\n${screen.join("\n")}`)
  const column = screen[current]!.indexOf("›")
  const action = (line: string | undefined) =>
    line !== undefined && line.slice(0, column).trim() === "" && /^[› ]\S/.test(line.slice(column))
  let first = current
  while (action(screen[first - 1])) first--
  let last = current
  while (action(screen[last + 1])) last++
  const at = screen.slice(first, last + 1).findIndex((line) => line.includes(label))
  if (at < 0) throw new Error(`No "${label}" to choose. Screen:\n${screen.join("\n")}`)
  const moves = at - (current - first)
  for (let i = 0; i < Math.abs(moves); i++) {
    tui!.press(moves > 0 ? KEY.down : KEY.up)
    await Bun.sleep(80)
  }
  await Bun.sleep(150)
  tui!.press(KEY.enter)
}

/** Ticks the Terms box (focus starts on it) and chooses an action. */
async function acceptAnd(label: string) {
  tui!.press(KEY.space)
  await tui!.waitFor("[x] I accept the Terms")
  await choose(label)
}

async function slash(command: string) {
  await tui!.type(command)
  await Bun.sleep(300)
  tui!.press(KEY.enter)
}

describe("Welcome screen (XCOD-273)", () => {
  test(
    "first start: the copy, the free/paid line, an unticked Terms box; Create account runs the device flow into home",
    async () => {
      await start({ env: OFFICIAL, fake: { pendingPolls: 3 } })
      const screen = await tui!.waitFor("Welcome to Lunos")
      expect(screen).toContain("Create a free Lunos account to start. No card needed.")
      expect(screen).toContain("Free: the full harness, CLI, TUI, desktop app and every local feature.")
      expect(screen).toContain("Paid plans add cloud features")
      expect(screen).toContain("Your code stays on this computer unless you use cloud features.")
      expect(screen).toContain("[ ] I accept the Terms and the Privacy notice")
      expect(screen).not.toContain("card number")
      // Not ticked: Create account says so and stays here.
      await choose("Create a free account")
      await tui!.waitFor("Tick the box to accept the Terms")
      await acceptAnd("Create a free account")
      const device = await tui!.waitFor("Waiting for you to confirm in the browser…")
      expect(device).toContain("Code: WXYZ-2345")
      expect(device).toContain("██") // the code in large letters, and the QR code
      expect(device).toContain(`${idp!.origin}/activate`)
      expect(device).toContain("Or scan this with your phone")
      expect(device).toMatch(/\d+:\d\d left/)
      expect(device).toContain("Opened the sign-in page in your browser.")
      const until = Date.now() + 5_000
      while (!(await tui!.opened()) && Date.now() < until) await Bun.sleep(100)
      expect(await tui!.opened()).toContain(`${idp!.origin}/activate?user_code=WXYZ-2345`)
      expect(await tui!.waitFor("Signed in as pat@lunos.test · Plan: Free")).toContain(
        "Session kept in the test keychain.",
      )
      await tui!.waitFor("Ask anything")
      expect(JSON.parse(JSON.parse(await tui!.keychain()).secret).tokens.refresh_token).toBe("rt-1")
      // No card or billing call, ever.
      expect(idp!.requests.filter((request) => /billing|checkout|card/.test(request.path))).toEqual([])
      expect(proxy.lunos()).toEqual([])
    },
    TIMEOUT,
  )

  test(
    "a new account waits for the e-mail to be confirmed, offers Resend, then continues by itself",
    async () => {
      await start({ env: OFFICIAL, fake: { outcomes: ["unverified"], verifyAfter: 2 } })
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      await tui!.waitFor("Check your inbox at p…@lunos.test; this screen")
      await choose("Resend e-mail")
      // Lunos Cloud doesn't send it again yet: the screen says so instead of pretending.
      await tui!.waitFor("isn't available from Lunos Cloud yet")
      await tui!.waitFor("Signed in as pat@lunos.test", 30_000)
      await tui!.waitFor("Ask anything")
    },
    TIMEOUT,
  )

  test(
    "an e-mail that isn't confirmed in time: its message, and Try again",
    async () => {
      await start({
        env: { ...OFFICIAL, OPENCODE_TEST_VERIFY_WINDOW_MS: "1" },
        fake: { outcomes: ["unverified"], verifyAfter: 100 },
      })
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      const screen = await tui!.waitFor("✗ Your e-mail address isn't confirmed yet", 30_000)
      expect(screen).toContain("Try again")
      await choose("Try again")
      await tui!.waitFor("Check your inbox at p…@lunos.test")
    },
    TIMEOUT,
  )

  for (const [outcome, title] of [
    ["denied", "✗ The sign-in was denied"],
    ["expired", "✗ The sign-in code expired"],
  ] as const)
    test(
      `${outcome}: its message, and Try again signs in`,
      async () => {
        await start({ env: OFFICIAL, fake: { outcomes: [outcome] } })
        await tui!.waitFor("Welcome to Lunos")
        await acceptAnd("Sign in")
        expect(await tui!.waitFor(title, 30_000)).toContain("Try again")
        await choose("Try again")
        await tui!.waitFor("Signed in as pat@lunos.test", 30_000)
      },
      TIMEOUT,
    )

  test(
    "the sign-in service unreachable: its message, and Try again",
    async () => {
      await start({ env: OFFICIAL, config: { cloud: { issuer: "http://127.0.0.1:9" } } })
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      expect(await tui!.waitFor("✗ The sign-in service can't be reached")).toContain("Try again")
      await choose("Try again")
      await tui!.waitFor("✗ The sign-in service can't be reached")
    },
    TIMEOUT,
  )

  test(
    "offline during /login: its message, Try again, and Continue offline",
    async () => {
      // A build from source (no requirement): /login opens the same screen, on request.
      await start({ config: { cloud: { issuer: "https://lunos-test-offline.invalid" } } })
      await tui!.waitFor("Ask anything")
      await slash("/login")
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      const screen = await tui!.waitFor("✗ You're offline")
      expect(screen).toContain("Try again")
      expect(screen).toContain("Continue offline")
      await choose("Continue offline")
      await tui!.waitFor("Ask anything")
    },
    TIMEOUT,
  )

  test(
    "/account, /logout; the next start shows Welcome again; a prompt while signed out shows it too",
    async () => {
      await start({ env: OFFICIAL, fake: { platformRole: "support" } })
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      await tui!.waitFor("Ask anything")
      await slash("/account")
      const account = await tui!.waitFor("Organisations: acme (admin)")
      expect(account).toContain("Pat Lunos · pat@lunos.test")
      expect(account).toContain("Plan: Free")
      expect(account).toContain("Lunos role: support")
      expect(account).toContain("Devices: laptop (linux)")
      expect(account).toContain("Sign out everywhere")
      expect(account).toContain("Delete my account")
      tui!.press(KEY.escape)
      await Bun.sleep(300)
      await slash("/logout")
      await tui!.waitFor("Welcome to Lunos")
      expect(await tui!.keychain()).toBe("")
      await tui!.stop()

      // The next start: Welcome again (same HOME).
      const home = tui!.home
      tui = await Pty.launch({
        home,
        config: { cloud: { issuer: idp!.origin, endpoint: idp!.origin } },
        env: { ...proxied, ...OFFICIAL },
      })
      await tui.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      await tui.waitFor("Ask anything")
      // Signed out elsewhere (`lunos logout` in another terminal): a prompt brings the screen back.
      await fs.rm(path.join(tui.dirs.data, "opencode", "cloud", "test-keychain.json"))
      await tui.type("hello")
      await Bun.sleep(200)
      tui.press(KEY.enter)
      await tui.waitFor("Welcome to Lunos")
      // The prompt wasn't sent to a model: nothing listens on the model's port, and no session started.
      expect(idp!.requests.some((request) => request.path.includes("chat"))).toBe(false)
    },
    TIMEOUT,
  )

  test(
    "Delete my account (confirmed) asks Lunos Cloud, signs out and says what's left",
    async () => {
      await start({ env: OFFICIAL })
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      await tui!.waitFor("Ask anything")
      await slash("/account")
      await tui!.waitFor("Organisations: acme")
      // Sign out, Sign out everywhere, Delete my account.
      for (const key of [KEY.down, KEY.down]) {
        tui!.press(key)
        await Bun.sleep(100)
      }
      tui!.press(KEY.enter)
      await tui!.waitFor("Delete your Lunos account?")
      // Confirm is highlighted; Cancel is one step left.
      await Bun.sleep(200)
      tui!.press(KEY.enter)
      const deleted = (await tui!.waitFor("Account deleted")).replace(/\s+/g, " ")
      expect(deleted).toContain("Deleting the sign-in itself isn't available from Lunos Cloud yet")
      expect(idp!.state.deleted).toBe(true)
      expect(await tui!.keychain()).toBe("")
    },
    TIMEOUT,
  )

  test(
    "new Terms: a signed-in start asks again, never pre-ticked",
    async () => {
      await start({ env: OFFICIAL })
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      await tui!.waitFor("Ask anything")
      await tui!.stop()
      // An older accepted version on this machine.
      await fs.writeFile(
        path.join(tui!.dirs.data, "opencode", "cloud", "consent.json"),
        JSON.stringify({ version: "2000-01-01" }),
      )
      tui = await Pty.launch({
        home: tui!.home,
        config: { cloud: { issuer: idp!.origin, endpoint: idp!.origin } },
        env: { ...proxied, ...OFFICIAL },
      })
      const screen = await tui.waitFor("The Terms or the Privacy notice changed")
      expect(screen).toContain("[ ] I accept the Terms")
      await acceptAnd("Continue")
      await tui.waitFor("Ask anything")
    },
    TIMEOUT,
  )
})

describe("the Welcome screen can't be bypassed (XCOD-273)", () => {
  test(
    "ctrl+p opens no command palette over it",
    async () => {
      await start({ env: OFFICIAL })
      await tui!.waitFor("Welcome to Lunos")
      tui!.press("\x10")
      await Bun.sleep(1_000)
      const screen = tui!.screen.text()
      expect(screen).toContain("Create a free Lunos account to start")
      expect(screen).not.toContain("Commands")
    },
    TIMEOUT,
  )

  test(
    "lunos settings starts on the Welcome screen, not the settings window",
    async () => {
      const home = await start({ env: OFFICIAL, args: ["settings"] })
      await home.waitFor("Welcome to Lunos")
      await Bun.sleep(1_500)
      expect(home.screen.text()).toContain("Create a free Lunos account to start")
      expect(home.screen.text()).not.toContain("Models & agents")
    },
    TIMEOUT,
  )
})

describe("--mini, which has no Welcome screen (XCOD-273)", () => {
  test(
    "the same sign-in in line mode: the copy, consent asked (not assumed), the device flow",
    async () => {
      await start({ env: OFFICIAL, extraArgs: ["--mini"] })
      const screen = await tui!.waitFor("[y/N]")
      expect(screen).toContain("Create a free Lunos account to start. No card needed.")
      tui!.press("y\r")
      await tui!.waitFor("and confirm the code WXYZ-2345")
      await tui!.waitFor("Signed in as pat@lunos.test", 30_000)
    },
    TIMEOUT,
  )

  test(
    "declining the Terms stops the start",
    async () => {
      await start({ env: OFFICIAL, extraArgs: ["--mini"] })
      await tui!.waitFor("[y/N]")
      tui!.press("\r")
      await tui!.waitFor("Lunos needs a free account to start")
      expect(idp!.requests.filter((request) => request.path === "/device")).toEqual([])
    },
    TIMEOUT,
  )
})

describe("exemptions: no Welcome screen, and no call to a Lunos service (XCOD-273)", () => {
  // Lunos's own issuer (auth.lunos.tech), as a fresh install has it: any attempt shows in the proxy.
  const fresh = { config: {} as Record<string, unknown> }

  test(
    "positive control: without an exemption the start does try auth.lunos.tech (refused by the proxy)",
    async () => {
      await start({ ...fresh, env: OFFICIAL })
      await tui!.waitFor("Welcome to Lunos")
      const until = Date.now() + 15_000
      while (!proxy.lunos().length && Date.now() < until) await Bun.sleep(100)
      expect(proxy.lunos()).toContain("auth.lunos.tech:443")
    },
    TIMEOUT,
  )

  const cases: [string, Pty.Options][] = [
    ["managed auth.required: false", { ...fresh, env: OFFICIAL, managed: { auth: { required: false } } }],
    ["LUNOS_OFFLINE=1", { ...fresh, env: { ...OFFICIAL, LUNOS_OFFLINE: "1" } }],
    ["CI=true", { ...fresh, env: { ...OFFICIAL, CI: "true" } }],
    ["a build from source", { ...fresh }],
  ]
  for (const [name, options] of cases)
    test(
      name,
      async () => {
        await start(options)
        const screen = await tui!.waitFor("Ask anything")
        expect(screen).not.toContain("Welcome to Lunos")
        await Bun.sleep(3_000)
        expect(tui!.screen.text()).not.toContain("Welcome to Lunos")
        expect(proxy.lunos()).toEqual([])
      },
      TIMEOUT,
    )

  test(
    "an organisation's cloud.issuer: no Welcome, never auth.lunos.tech; /login signs in to that issuer",
    async () => {
      idp = FakeIdp.start()
      await start({ config: {}, env: OFFICIAL, managed: { cloud: { issuer: idp.origin } } })
      await tui!.waitFor("Ask anything")
      await Bun.sleep(2_000)
      expect(tui!.screen.text()).not.toContain("Welcome to Lunos")
      await slash("/login")
      await tui!.waitFor("Welcome to Lunos")
      await acceptAnd("Sign in")
      await tui!.waitFor("Signed in as pat@lunos.test")
      expect(idp.requests.map((request) => request.path)).toContain("/device")
      expect(proxy.lunos()).toEqual([])
    },
    TIMEOUT,
  )

  test(
    "no network at first start: a one-time notice, and work continues",
    async () => {
      await start({ config: { cloud: { issuer: "https://lunos-test-offline.invalid" } }, env: OFFICIAL })
      await tui!.waitFor("Offline: sign in later with /login")
      await tui!.waitFor("Ask anything")
      expect(proxy.lunos()).toEqual([])
    },
    TIMEOUT,
  )

  test(
    "lunos run (not a terminal) never asks, and contacts no Lunos service",
    async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-run-"))
      homes.push(home)
      const model = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          const chunk = (payload: object) =>
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...payload })}\n\n`
          return new Response(
            chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "run ok" }, finish_reason: null }] }) +
              chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
              chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        const project = path.join(home, "project")
        await fs.mkdir(project, { recursive: true })
        await Bun.$`git init -q .`.cwd(project).quiet()
        // Not spawnSync: the fake model answers from this process, which must keep running.
        const child = Bun.spawn(
          [process.execPath, "run", path.resolve(import.meta.dir, "../../src/index.ts"), "run", "Say run ok"],
          {
            cwd: project,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: home,
              XDG_CONFIG_HOME: path.join(home, ".config"),
              XDG_DATA_HOME: path.join(home, ".local/share"),
              XDG_CACHE_HOME: path.join(home, ".cache"),
              XDG_STATE_HOME: path.join(home, ".local/state"),
              OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
              LUNOS_CLOUD_STORE: "test-keychain",
              LUNOS_AUTH_REQUIRED: "1",
              OPENCODE_DISABLE_MODELS_FETCH: "1",
              OPENCODE_DISABLE_AUTOUPDATE: "1",
              OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
              HTTPS_PROXY: proxy.url,
              HTTP_PROXY: proxy.url,
              NO_PROXY: "127.0.0.1,localhost",
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                model: "local/m",
                provider: {
                  local: {
                    npm: "@ai-sdk/openai-compatible",
                    name: "Local",
                    options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "unused" },
                    models: { m: { name: "m" } },
                  },
                },
              }),
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: 90_000,
          },
        )
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        await child.exited
        const output = stdout + stderr
        expect(output).toContain("run ok")
        expect(output).not.toContain("Welcome to Lunos")
        expect(proxy.lunos()).toEqual([])
      } finally {
        model.stop(true)
      }
    },
    TIMEOUT,
  )
})

// The compiled official build (`LUNOS_OFFICIAL_BUILD=1 ./script/build.ts --single`), when
// LUNOS_TEST_BINARY points at it: the build flag is compiled in, and the exemptions are read at
// run time, not snapshotted with Flag when the binary loads. No LUNOS_AUTH_REQUIRED here.
const binary = process.env.LUNOS_TEST_BINARY
describe.skipIf(!binary)("the compiled official build (XCOD-273)", () => {
  test(
    "requires a sign-in with no exemption",
    async () => {
      await start({ binary })
      await tui!.waitFor("Welcome to Lunos", 60_000)
      await acceptAnd("Sign in")
      await tui!.waitFor("Signed in as pat@lunos.test", 30_000)
    },
    TIMEOUT,
  )

  const cases: [string, Pty.Options][] = [
    ["CI=true", { config: {}, env: { CI: "true" } }],
    ["LUNOS_OFFLINE=1", { config: {}, env: { LUNOS_OFFLINE: "1" } }],
    ["managed auth.required: false", { config: {}, managed: { auth: { required: false } } }],
  ]
  for (const [name, options] of cases)
    test(
      `${name}: no Welcome, no Lunos host`,
      async () => {
        await start({ ...options, binary })
        await tui!.waitFor("Ask anything", 60_000)
        await Bun.sleep(3_000)
        expect(tui!.screen.text()).not.toContain("Welcome to Lunos")
        expect(proxy.lunos()).toEqual([])
      },
      TIMEOUT,
    )
})
