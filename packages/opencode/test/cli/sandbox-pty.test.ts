import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import * as Pty from "./fixtures/tui-pty"

// XCOD-281: the sandbox starts behind the TUI, in the real TUI (from source) in a pty at 120x45,
// isolated (throwaway HOME/XDG, the stand-in keychain). Docker is a fake `docker` on the pty's PATH
// whose engine "isn't running" (after a delay, so a prompt can be typed while it starts); it writes
// down each call. The model is a local fake that counts what it's asked; nothing hosted is reached.

const TIMEOUT = 120_000
const { KEY } = Pty

let proxy: Awaited<ReturnType<typeof Pty.recordingProxy>>
let run: Awaited<ReturnType<typeof Pty.launch>> | undefined
const homes: string[] = []
let model: ReturnType<typeof Bun.serve>
let asked = 0

beforeAll(async () => {
  proxy = await Pty.recordingProxy()
  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      asked++
      return new Response("no", { status: 500 })
    },
  })
})
afterAll(async () => {
  await proxy.close()
  model.stop(true)
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})
afterEach(async () => {
  await run?.stop()
  run = undefined
})

const STOPPED = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"

/** A home whose `docker` is stopped, answering after `delay` seconds. */
async function home(config: Record<string, unknown>, delay = 2) {
  const prepared = await Pty.prepare({ config })
  homes.push(prepared.home)
  const calls = path.join(prepared.home, "docker-calls.txt")
  await fs.writeFile(
    path.join(prepared.dirs.bin, "docker"),
    `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  --version) echo "Docker version 27.3.1, build ce12230"; exit 0 ;;
esac
sleep ${delay}
echo '${STOPPED}' >&2
exit 1
`,
  )
  await fs.chmod(path.join(prepared.dirs.bin, "docker"), 0o755)
  return {
    ...prepared,
    calls: () =>
      fs.readFile(calls, "utf8").then(
        (text) => text.split("\n").filter((line) => line.startsWith("info")).length,
        () => 0,
      ),
    config: path.join(prepared.dirs.config, "opencode", "opencode.json"),
  }
}

const env = () => ({
  HTTPS_PROXY: proxy.url,
  HTTP_PROXY: proxy.url,
  // The local model: a fake that counts requests.
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
})

async function flag(state: string) {
  const file = path.join(state, "opencode", "sandbox-auto-disabled.json")
  return fs.readFile(file, "utf8").then(
    (text) => JSON.parse(text) as Record<string, { reason: string; fix?: string; config: string }>,
    () => undefined,
  )
}

/** Sessions in this computer's database (none when it was never created). */
async function sessions(data: string) {
  const { Database } = await import("bun:sqlite")
  const names = await fs.readdir(path.join(data, "opencode")).catch(() => [] as string[])
  let count = 0
  for (const name of names.filter((item) => /^opencode.*\.db$/.test(item))) {
    const db = new Database(path.join(data, "opencode", name), { readonly: true })
    try {
      count += (db.query("select count(*) as n from session").get() as { n: number } | null)?.n ?? 0
    } catch {
      // No session table: nothing was ever stored.
    } finally {
      db.close()
    }
  }
  return count
}

async function gone(text: string, timeout = 30_000) {
  const until = Date.now() + timeout
  while (run!.screen.text().includes(text) && Date.now() < until) await Bun.sleep(100)
  return !run!.screen.text().includes(text)
}

describe.skipIf(process.platform === "win32")("the sandbox starts in the background", () => {
  test(
    "opens at once; a prompt waits for the sandbox; Docker stopped: turned off here, toast, badge, Discard",
    async () => {
      const h = await home({ sandbox: { enabled: true } })
      const before = await fs.readFile(h.config)
      run = await Pty.launch({ home: h.home, env: env() })
      // The home screen is up while the sandbox starts.
      await run.waitFor("Sandbox starting…", 20_000)
      await run.waitFor("Ask anything")
      await run.type("queued hello")
      run.press(KEY.enter)
      await run.waitFor("Waiting for sandbox… your prompt is sent once it's ready")
      // It fails: Lunos starts again without it, with the prompt back, and asks before sending it.
      const screen = await run.waitFor("Lunos is running WITHOUT the sandbox.", 30_000)
      expect(screen).toContain("⚠ The sandbox couldn't start: Docker Desktop isn't")
      expect(screen).not.toContain("Unexpected error")
      for (const action of ["[Open log]", "[Retry]", "[Settings]"]) expect(screen).toContain(action)
      await run.waitFor("Send the queued prompt to the host (no sandbox)?")
      await run.waitFor("no sandbox · sandbox off after a failure on")
      // Not sent until the user chooses.
      await Bun.sleep(1500)
      expect(asked).toBe(0)
      run.press(KEY.down)
      await Bun.sleep(150)
      run.press(KEY.enter)
      expect(await gone("Send the queued prompt")).toBe(true)
      await Bun.sleep(500)
      expect(run.screen.text()).not.toContain("queued hello")
      expect(asked).toBe(0)
      // Turned off in local state, with the reason; the config file is byte for byte the same.
      const stored = Object.values((await flag(h.dirs.state)) ?? {})
      expect(stored).toHaveLength(1)
      expect(stored[0]!.fix).toContain("isn't running")
      expect((await fs.readFile(h.config)).equals(before)).toBe(true)

      // The next start: on this computer, the badge, no toast, no new attempt.
      await run.stop()
      const attempts = await h.calls()
      run = await Pty.launch({ home: h.home, env: env() })
      await run.waitFor("no sandbox · sandbox off after a failure on")
      await run.waitFor("Ask anything")
      await Bun.sleep(1500)
      expect(run.screen.text()).not.toContain("couldn't start")
      expect(await h.calls()).toBe(attempts)

      // Retry: Lunos starts again with the sandbox, which tries again (Docker is still stopped).
      await run.type("/sandbox-retry")
      await Bun.sleep(300)
      run.press(KEY.enter)
      await run.waitFor("Sandbox starting…", 30_000)
      await run.waitFor("Lunos is running WITHOUT the sandbox.", 30_000)
      expect(await h.calls()).toBeGreaterThan(attempts)
    },
    TIMEOUT,
  )

  test(
    "Send: the queued prompt goes to the host once chosen",
    async () => {
      const h = await home({ sandbox: { enabled: true } })
      run = await Pty.launch({ home: h.home, env: env() })
      await run.waitFor("Ask anything", 20_000)
      await run.type("send me")
      run.press(KEY.enter)
      await run.waitFor("Waiting for sandbox…")
      await run.waitFor("Send the queued prompt to the host (no sandbox)?", 30_000)
      const before = asked
      run.press(KEY.enter)
      const until = Date.now() + 30_000
      while (asked === before && Date.now() < until) await Bun.sleep(100)
      expect(asked).toBeGreaterThan(before)
    },
    TIMEOUT,
  )

  test(
    "sandbox.required: opens, prompts are blocked with a banner and the log, nothing runs on the host",
    async () => {
      const h = await home({ sandbox: { required: true } }, 1)
      const asks = asked
      run = await Pty.launch({ home: h.home, env: env() })
      await run.waitFor("Ask anything", 20_000)
      const screen = await run.waitFor("Prompts can't run until it starts. Nothing runs on this computer.", 30_000)
      expect(screen).toContain("The sandbox is required here, and it couldn't start")
      expect(screen).toContain("[Retry]")
      expect(screen).toContain("[Open log]")
      expect(screen).toMatch(/Log: .*lunos-/)
      // Retry tries again here (no restart), and is blocked again.
      const attempts = await h.calls()
      await run.type("/sandbox-retry")
      await Bun.sleep(300)
      run.press(KEY.enter)
      const until = Date.now() + 20_000
      while ((await h.calls()) === attempts && Date.now() < until) await Bun.sleep(100)
      expect(await h.calls()).toBeGreaterThan(attempts)
      await run.waitFor("Prompts can't run until it starts.", 20_000)
      await run.type("run a tool")
      run.press(KEY.enter)
      await run.waitFor("Waiting for sandbox… your prompt is sent once it's ready")
      await Bun.sleep(2000)
      // No model call, and no session on this computer: no server ever ran a prompt here.
      expect(asked).toBe(asks)
      expect(await sessions(h.dirs.data)).toBe(0)
      // Not turned off: required ignores it.
      expect(await flag(h.dirs.state)).toBeUndefined()
    },
    TIMEOUT,
  )
})

describe.skipIf(process.platform === "win32")("the sandbox failing at once", () => {
  test(
    "no delay (Docker missing or stopped): the TUI opens, starts again without it, and shows the toast",
    async () => {
      const h = await home({ sandbox: { enabled: true } }, 0)
      run = await Pty.launch({ home: h.home, env: env() })
      await run.waitFor("Lunos is running WITHOUT the sandbox.", 30_000)
      await run.waitFor("no sandbox · sandbox off after a failure on")
      await run.waitFor("Ask anything")
      expect(run.exited()).toBeUndefined()
    },
    TIMEOUT,
  )

  test(
    "`lunos --sandbox=strict`: no fallback; blocked with the banner, as when it's required",
    async () => {
      const h = await home({}, 0)
      const asks = asked
      run = await Pty.launch({ home: h.home, env: env(), extraArgs: ["--sandbox=strict"] })
      const screen = await run.waitFor("You started Lunos with --sandbox=strict, and it couldn't start", 30_000)
      expect(screen).toContain("Prompts can't run until it starts.")
      expect(screen).not.toContain("WITHOUT the sandbox")
      expect(await flag(h.dirs.state)).toBeUndefined()
      expect(asked).toBe(asks)
    },
    TIMEOUT,
  )
})

describe.skipIf(process.platform === "win32")("`lunos run` with the sandbox failing", () => {
  test(
    "warns in one line and runs without it; --sandbox=strict exits 1 with the reason",
    async () => {
      const h = await home({ sandbox: { enabled: true } }, 0)
      const options = { home: h.home, env: env() }
      const before = asked
      const loose = await Pty.exec(["run", "--sandbox", "hello"], options)
      expect(loose.stdout + loose.stderr).toMatch(
        /sandbox failed, running without it: Docker Desktop isn't running.*log: /,
      )
      // It went on, here: the project instance loaded and the model was asked.
      expect(asked).toBeGreaterThan(before)
      expect(loose.stderr).not.toMatch(/No context found|InstanceContext|instance/i)
      const strict = await Pty.exec(["run", "--sandbox=strict", "hello"], options)
      expect(strict.code).toBe(1)
      expect(strict.stdout + strict.stderr).toContain("The sandbox couldn't start")
      expect(strict.stdout + strict.stderr).not.toContain("running without it")
    },
    TIMEOUT,
  )
})
