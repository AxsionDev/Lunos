// XCOD-281: the sandbox starts behind the TUI. The TUI's transport waits for it and goes nowhere
// else; a failure turns the sandbox off through local state (never a config file), or under
// sandbox.required blocks until Retry works. Docker is a fake `docker` script on PATH; no daemon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { SandboxBackground } from "../../src/sandbox/background"
import { SandboxDisabled } from "../../src/sandbox/disabled"
import { SandboxConfig } from "../../src/sandbox/config"
import { SandboxDocker } from "../../src/sandbox/docker"
import { runSandboxed, sandboxOff, sandboxTui, startsSandboxed, strictArg, wanted } from "../../src/cli/cmd/sandbox"
import { relaunchFor } from "../../src/cli/cmd/tui"
import { tmpdir } from "../fixture/fixture"

const STOPPED = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"

/** A `docker` whose engine isn't running. */
async function stoppedDocker() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-fake-docker-"))
  const script = `#!/bin/sh
case "$1" in
  --version) echo "Docker version 27.3.1, build ce12230"; exit 0 ;;
esac
echo '${STOPPED}' >&2
exit 1
`
  await Bun.write(path.join(dir, "docker"), script)
  await fs.chmod(path.join(dir, "docker"), 0o755)
  return dir
}

const posixOnly = process.platform === "win32"

let savedPath: string | undefined
beforeEach(() => {
  savedPath = process.env.PATH
})
afterEach(() => {
  process.env.PATH = savedPath
})

/** A fake sandbox server: records what reached it. */
function fakeServer() {
  const seen: { path: string; auth: string | null; directory: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      seen.push({
        path: url.pathname + url.search,
        auth: request.headers.get("authorization"),
        directory: url.searchParams.get("directory"),
      })
      return Response.json({ ok: true })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

async function project(sandbox: Record<string, unknown>) {
  const dir = await tmpdir({ git: true })
  const file = path.join(dir.path, "opencode.json")
  await Bun.write(file, JSON.stringify({ sandbox }, null, 2))
  return { dir, file }
}

describe("the transport while the sandbox starts", () => {
  test("a request waits (it doesn't fail) and then goes to the sandbox's server, with its auth", async () => {
    const server = fakeServer()
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const background = SandboxBackground.start({
      launch: async (progress) => {
        progress("copying the project")
        await gate
        return { url: server.url, headers: { Authorization: "Basic c2FuZGJveA==" } }
      },
      failed: () => {
        throw new Error("not failed")
      },
      ready: () => ({ status: "ready", id: "abcd1234" }),
    })
    expect(background.host.state()).toEqual({ status: "starting", detail: "copying the project" })
    const response = background.fetch("http://opencode.internal/session?directory=%2Fworkspace%2Fapp")
    let settled = false
    void response.then(() => (settled = true))
    await Bun.sleep(200)
    expect(settled).toBe(false)
    expect(server.seen).toEqual([])
    open()
    expect(await (await response).json()).toEqual({ ok: true })
    expect(server.seen).toEqual([
      { path: "/session?directory=%2Fworkspace%2Fapp", auth: "Basic c2FuZGJveA==", directory: "/workspace/app" },
    ])
    expect(background.host.state()).toEqual({ status: "ready", id: "abcd1234" })
    server.stop()
  })

  test("a cancelled request stops waiting", async () => {
    const background = SandboxBackground.start({
      launch: () => new Promise(() => {}),
      failed: () => ({ status: "failed", failure: { reason: "x", time: "" } }),
    })
    const abort = new AbortController()
    const response = background.fetch("http://opencode.internal/global/event", { signal: abort.signal })
    abort.abort()
    await expect(response).rejects.toBeDefined()
  })

  test("required: a failure blocks, nothing is served meanwhile, and Retry starts it here", async () => {
    const server = fakeServer()
    let attempts = 0
    const background = SandboxBackground.start({
      launch: async () => {
        attempts++
        if (attempts === 1) throw new Error("Docker Desktop isn't running")
        return { url: server.url, headers: {} }
      },
      failed: (error) => ({
        status: "blocked",
        failure: { reason: (error as Error).message, time: new Date().toISOString(), requiredBy: "managed" },
      }),
      ready: () => ({ status: "ready", id: "b" }),
    })
    const waiting = background.fetch("http://opencode.internal/session/x/message", { method: "POST", body: "{}" })
    await background.settled()
    expect(background.host.state()).toMatchObject({ status: "blocked", failure: { requiredBy: "managed" } })
    await Bun.sleep(100)
    expect(server.seen).toEqual([])
    background.host.retry()
    await background.settled()
    await waiting
    expect(server.seen.map((item) => item.path)).toEqual(["/session/x/message"])
    server.stop()
  })
})

describe("sandbox_auto_disabled", () => {
  test("lives in local state, keyed by project; a sandbox config change clears it", async () => {
    const { dir, file } = await project({ enabled: true })
    await using _ = dir
    SandboxDisabled.set(dir.path, { reason: "Docker isn't running", time: "2026-10-20T10:00:00.000Z" })
    expect(SandboxDisabled.file()).toStartWith(Global.Path.state)
    expect(SandboxDisabled.get(dir.path)).toMatchObject({ reason: "Docker isn't running" })
    expect(wanted({}, dir.path)).toBe(false)
    // --sandbox is an explicit try.
    expect(wanted({ sandbox: true }, dir.path)).toBe(true)
    await Bun.write(file, JSON.stringify({ sandbox: { enabled: true, network: "none" } }))
    expect(SandboxDisabled.get(dir.path)).toBeUndefined()
    expect(wanted({}, dir.path)).toBe(true)
  })

  test("sandbox.required ignores it", async () => {
    const { dir } = await project({ required: true })
    await using _ = dir
    SandboxDisabled.set(dir.path, { reason: "x", time: "2026-10-20T10:00:00.000Z" })
    expect(wanted({}, dir.path)).toBe(true)
    expect(startsSandboxed({}, dir.path, { failed: { reason: "x", time: "" } })).toBe(true)
    SandboxDisabled.clear(dir.path)
  })

  test("the next start: on this computer, the badge without the toast; after a failure, the toast", async () => {
    const { dir } = await project({ enabled: true })
    await using _ = dir
    expect(sandboxOff(dir.path)).toBeUndefined()
    const failure = { reason: "Docker isn't running", time: "2026-10-20T10:00:00.000Z" }
    SandboxDisabled.set(dir.path, failure)
    expect(startsSandboxed({}, dir.path)).toBe(false)
    expect(sandboxOff(dir.path)?.state()).toMatchObject({ status: "off", announce: false, failure })
    expect(sandboxOff(dir.path, { failed: failure }, true)?.state()).toMatchObject({ announce: true, queued: true })
    // Re-enable clears it.
    sandboxOff(dir.path)!.reenable()
    expect(SandboxDisabled.get(dir.path)).toBeUndefined()
    expect(startsSandboxed({}, dir.path)).toBe(true)
  })

  test("a relaunch after a failure starts without it; a Retry with it", async () => {
    const { dir } = await project({ enabled: true })
    await using _ = dir
    const failure = { reason: "x", time: "" }
    expect(startsSandboxed({ sandbox: true }, dir.path, { failed: failure })).toBe(false)
    expect(startsSandboxed({ sandbox: false }, dir.path, { retry: true })).toBe(true)
    const request = { sessionID: "ses_1", fresh: false, cancelled: [] }
    expect(relaunchFor({ ...request, sandbox: "failed" }, { status: "failed", failure })).toEqual([
      { ...request, sandbox: "failed", sessionID: undefined, fresh: true },
      undefined,
      { sandbox: { failed: failure } },
    ])
    expect(relaunchFor({ ...request, sandbox: "retry" }, { status: "off", failure })[2]).toEqual({
      sandbox: { retry: true },
    })
    // A sandboxed session doesn't outlive its sandbox; on this computer /restart keeps the session.
    expect(relaunchFor(request, { status: "ready", id: "x" })[0].sessionID).toBeUndefined()
    expect(relaunchFor(request, undefined)[0].sessionID).toBe("ses_1")
  })
})

describe.skipIf(posixOnly)("Docker stopped", () => {
  test("the TUI's sandbox fails in the background: turned off here, config files unchanged", async () => {
    const { dir, file } = await project({ enabled: true })
    await using _ = dir
    const global = path.join(Global.Path.config, "opencode.json")
    await fs.mkdir(path.dirname(global), { recursive: true })
    await Bun.write(global, JSON.stringify({ sandbox: { network: "policy" } }, null, 2))
    const before = [readFileSync(file), readFileSync(global)]
    process.env.PATH = [await stoppedDocker(), "/usr/bin", "/bin"].join(path.delimiter)

    const sandbox = await sandboxTui(dir.path, {})
    // Known before the container exists: the TUI opens on it at once.
    expect(sandbox.directory).toBe(SandboxDocker.WORKSPACE)
    expect(sandbox.host.state().status).toBe("starting")
    const until = Date.now() + 20_000
    while (sandbox.host.state().status === "starting" && Date.now() < until) await Bun.sleep(50)
    const state = sandbox.host.state()
    expect(state.status).toBe("failed")
    if (state.status !== "failed") return
    expect(state.failure.fix).toContain("isn't running")
    expect(state.failure.reason).not.toContain("Unexpected error")
    expect(SandboxDisabled.get(dir.path)).toMatchObject({ reason: state.failure.reason })
    expect([readFileSync(file), readFileSync(global)].map((item, index) => item.equals(before[index]!))).toEqual([
      true,
      true,
    ])
    await sandbox.finish()
    SandboxDisabled.clear(dir.path)
    await fs.rm(global, { force: true })
  }, 30_000)

  test("required: blocked, and the transport never serves anything", async () => {
    const { dir } = await project({ required: true })
    await using _ = dir
    process.env.PATH = [await stoppedDocker(), "/usr/bin", "/bin"].join(path.delimiter)
    const sandbox = await sandboxTui(dir.path, {})
    let answered = false
    void sandbox.fetch("http://opencode.internal/session").then(() => (answered = true))
    const until = Date.now() + 20_000
    while (sandbox.host.state().status === "starting" && Date.now() < until) await Bun.sleep(50)
    expect(sandbox.host.state()).toMatchObject({ status: "blocked", failure: { requiredBy: "config" } })
    await Bun.sleep(200)
    expect(answered).toBe(false)
    expect(SandboxDisabled.get(dir.path)).toBeUndefined()
    await sandbox.finish()
  }, 30_000)

  test("`lunos run`: warns and runs here; --sandbox=strict and required keep the error", async () => {
    const { dir } = await project({ enabled: true })
    await using _ = dir
    process.env.PATH = [await stoppedDocker(), "/usr/bin", "/bin"].join(path.delimiter)
    let ranHere = 0
    const client = async () => {
      throw new Error("never in a sandbox")
    }
    await runSandboxed(dir.path, client, {}, { host: async () => void ranHere++ })
    expect(ranHere).toBe(1)
    await expect(
      runSandboxed(dir.path, client, {}, { strict: true, host: async () => void ranHere++ }),
    ).rejects.toThrow("The sandbox couldn't start")
    expect(ranHere).toBe(1)
    const required = await project({ required: true })
    await using __ = required.dir
    await expect(runSandboxed(required.dir.path, client, {}, { host: async () => void ranHere++ })).rejects.toThrow()
    expect(ranHere).toBe(1)
  }, 30_000)

  test("--sandbox=strict is recognised as written", () => {
    expect(strictArg(["bun", "lunos", "run", "--sandbox=strict", "fix it"])).toBe(true)
    expect(strictArg(["bun", "lunos", "run", "--sandbox", "fix it"])).toBe(false)
  })
})

test("the config's hash covers every sandbox setting", async () => {
  const { dir } = await project({ enabled: true })
  await using _ = dir
  const config = SandboxConfig.load(dir.path)
  expect(SandboxDisabled.hash(config)).toBe(SandboxDisabled.hash({ ...config }))
  expect(SandboxDisabled.hash({ ...config, image: "other" })).not.toBe(SandboxDisabled.hash(config))
})
