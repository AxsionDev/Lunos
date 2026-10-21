import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { BackgroundShell } from "../../src/tool/shell/background"
import { buildProof } from "../../src/session/prompt"
import { Permission } from "../../src/permission"
import { ConfigPolicy } from "../../src/config/policy"

// XCOD-288: background commands for dev servers: start, readiness, cleanup.

const posix = process.platform !== "win32"
const shell = posix ? (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh") : process.env.COMSPEC || "cmd.exe"
const bun = JSON.stringify(process.execPath)
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "lunos-bg-test-"))

function alive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function groupAlive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await Bun.sleep(100)
  }
  return check()
}

/** A one-file Bun HTTP server on an OS-picked port that prints `PORT <n>` and answers "ok". */
function serverScript(hostname = "127.0.0.1") {
  const file = path.join(logDir, `server-${Math.random().toString(36).slice(2)}.ts`)
  fs.writeFileSync(
    file,
    `const s = Bun.serve({ port: 0, hostname: ${JSON.stringify(hostname)}, fetch: () => new Response("ok") }); console.log("PORT " + s.port)`,
  )
  return `${bun} ${JSON.stringify(file)}`
}

async function portOf(info: BackgroundShell.Info) {
  let port: number | undefined
  await until(() => {
    const match = BackgroundShell.tail(info).match(/PORT (\d+)/)
    if (match) port = Number(match[1])
    return port !== undefined
  }, 10_000)
  if (!port) throw new Error("server never printed its port:\n" + BackgroundShell.tail(info))
  return port
}

const start = (command: string, extra: Partial<BackgroundShell.StartInput> = {}) =>
  BackgroundShell.start({
    sessionID: "ses_bg",
    directory: logDir,
    command,
    shell,
    cwd: logDir,
    env: process.env,
    logDir,
    ...extra,
  })

afterEach(async () => {
  await BackgroundShell.reset()
})

describe("BackgroundShell.parseReadyUrl", () => {
  test("accepts loopback http(s) URLs", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1:5173/x?y=1",
      "https://[::1]:8443/",
      "http://127.0.0.2/",
    ])
      expect(BackgroundShell.parseReadyUrl(url).href).toBe(new URL(url).href)
  })

  test("refuses anything that isn't this machine, or isn't http", () => {
    for (const url of [
      "http://example.com/",
      "http://0.0.0.0:3000/",
      "http://192.168.1.10:3000/",
      "file:///etc/passwd",
      "nope",
    ])
      expect(() => BackgroundShell.parseReadyUrl(url)).toThrow()
  })
})

describe("BackgroundShell.loopbackAddress", () => {
  test("tells loopback binds from exposed ones", () => {
    expect(BackgroundShell.loopbackAddress("127.0.0.1:3000")).toBe(true)
    expect(BackgroundShell.loopbackAddress("[::1]:3000")).toBe(true)
    expect(BackgroundShell.loopbackAddress("localhost:3000")).toBe(true)
    expect(BackgroundShell.loopbackAddress("*:3000")).toBe(false)
    expect(BackgroundShell.loopbackAddress("0.0.0.0:3000")).toBe(false)
    expect(BackgroundShell.loopbackAddress("[::]:3000")).toBe(false)
    expect(BackgroundShell.loopbackAddress("192.168.1.10:3000")).toBe(false)
  })
})

describe("BackgroundShell", () => {
  test("starts a server in the background, waits until it answers, and stops it", async () => {
    const info = start(serverScript())
    expect(info.status).toBe("running")
    const port = await portOf(info)
    const ready = await BackgroundShell.waitReady(info, new URL(`http://localhost:${port}/`), 10_000)
    expect(ready.ready).toBe(true)
    if (ready.ready) expect(ready.status).toBe(200)
    expect(alive(info.pid)).toBe(true)

    await BackgroundShell.stop(info.id)
    expect(info.status).toBe("stopped")
    expect(await until(() => !alive(info.pid), 5000)).toBe(true)
    // Nothing still answers on the port: the server, not only its shell, is gone.
    const after = await fetch(`http://127.0.0.1:${port}/`).then(
      () => "answered",
      () => "refused",
    )
    expect(after).toBe("refused")
  }, 30_000)

  test("reports a command that exits before it is ready, at once rather than at the timeout", async () => {
    const info = start(`echo boom; exit 3`)
    const started = Date.now()
    const ready = await BackgroundShell.waitReady(info, new URL("http://127.0.0.1:9/"), 30_000)
    expect(ready.ready).toBe(false)
    if (!ready.ready) expect(ready.reason).toBe("exited")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(info.exitCode).toBe(3)
    expect(BackgroundShell.tail(info)).toContain("boom")
  }, 30_000)

  test("gives up after the timeout when nothing answers", async () => {
    const info = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1")
    const ready = await BackgroundShell.waitReady(info, new URL("http://127.0.0.1:9/"), 1000)
    expect(ready.ready).toBe(false)
    if (!ready.ready) expect(ready.reason).toBe("timeout")
    expect(ready.elapsedMs).toBeLessThan(6000)
  }, 30_000)

  test("stops after its lifetime", async () => {
    const info = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1", { lifetimeMs: 500 })
    expect(await until(() => info.status === "expired", 5000)).toBe(true)
    expect(await until(() => !alive(info.pid), 5000)).toBe(true)
  }, 30_000)

  test("the end of a turn stops what it started, except what was kept", async () => {
    const used = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1", { sessionID: "ses_turn" })
    const kept = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1", { sessionID: "ses_turn" })
    const other = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1", { sessionID: "ses_busy" })
    kept.keep = true
    await BackgroundShell.endTurn("ses_turn")
    expect(used.status).toBe("stopped")
    expect(await until(() => !alive(used.pid), 5000)).toBe(true)
    expect(kept.status).toBe("running")
    expect(alive(kept.pid)).toBe(true)
    expect(other.status).toBe("running")
  }, 30_000)

  test("refuses to call a port this session didn't start ready", async () => {
    const stranger = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("someone else") })
    try {
      expect(await BackgroundShell.answers(new URL(`http://127.0.0.1:${stranger.port}/`))).toBe(true)
      const info = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1")
      if (posix && Bun.which("lsof"))
        expect(BackgroundShell.owns(info, new URL(`http://127.0.0.1:${stranger.port}/`))).toBe(false)
    } finally {
      stranger.stop(true)
    }
    expect(await BackgroundShell.answers(new URL("http://127.0.0.1:9/"))).toBe(false)
  }, 30_000)

  test("its log file is readable by the owner only", () => {
    if (!posix) return
    const info = start("echo secret")
    expect(fs.statSync(info.log).mode & 0o777).toBe(0o600)
  })

  test("stopping a session stops only that session's processes", async () => {
    const mine = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1", { sessionID: "ses_mine" })
    const other = start(posix ? "sleep 30" : "ping -n 30 127.0.0.1", { sessionID: "ses_other" })
    await BackgroundShell.stopSession("ses_mine")
    expect(mine.status).toBe("stopped")
    expect(other.status).toBe("running")
    expect(BackgroundShell.list("ses_other").map((item) => item.id)).toEqual([other.id])
  }, 30_000)

  test("stopping kills what the command started, not only its shell", async () => {
    if (!posix) return
    // `sh -c 'a; b'` keeps a shell between the process group leader and the server.
    const info = start(`${serverScript()}; echo after`)
    const port = await portOf(info)
    expect((await BackgroundShell.waitReady(info, new URL(`http://127.0.0.1:${port}/`), 10_000)).ready).toBe(true)
    await BackgroundShell.stop(info.id)
    expect(await until(() => !groupAlive(info.pid), 5000)).toBe(true)
  }, 30_000)

  test("reports where the server listens, and flags a wildcard bind", async () => {
    if (!posix || !Bun.which("lsof")) return
    const local = start(serverScript("127.0.0.1"))
    const localPort = await portOf(local)
    await BackgroundShell.waitReady(local, new URL(`http://127.0.0.1:${localPort}/`), 10_000)
    const a = BackgroundShell.listening(local)
    expect(a.checked).toBe(true)
    if (a.checked) {
      expect(a.addresses).toContain(`127.0.0.1:${localPort}`)
      expect(a.exposed).toEqual([])
    }

    const open = start(serverScript("0.0.0.0"))
    const openPort = await portOf(open)
    await BackgroundShell.waitReady(open, new URL(`http://127.0.0.1:${openPort}/`), 10_000)
    const b = BackgroundShell.listening(open)
    expect(b.checked).toBe(true)
    if (b.checked) expect(b.exposed).toContain(`*:${openPort}`)
  }, 30_000)

  test("the watchdog takes the process group down when its Lunos process dies", async () => {
    if (!posix) return
    // Stand-in for Lunos: a process that starts a background command and is then SIGKILLed, so
    // none of its own cleanup can run.
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const script = serverScript()
    const child = spawn(shell, ["-c", BackgroundShell.wrap(script, parent.pid!, 60_000)], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    })
    child.unref()
    expect(await until(() => groupAlive(child.pid), 5000)).toBe(true)
    parent.kill("SIGKILL")
    expect(await until(() => !groupAlive(child.pid), 10_000)).toBe(true)
  }, 30_000)
})

describe("buildProof", () => {
  test("only for the build agent, and only when it may use the shell", () => {
    const allow = Permission.fromConfig({ bash: "allow" })
    const deny = Permission.fromConfig({ bash: "deny" })
    expect(buildProof({ name: "build", permission: allow })).toContain("# Finish with proof")
    expect(buildProof({ name: "plan", permission: allow })).toBeUndefined()
    expect(buildProof({ name: "build", permission: deny })).toBeUndefined()
    expect(buildProof({ name: "build", permission: allow }, deny)).toBeUndefined()
  })

  test("pins the project's verify commands, attempts and time budget", () => {
    const text = buildProof({ name: "build", permission: [] }, undefined, {
      verify: {
        build: "npm run build",
        test: "npm test",
        start: "npm run dev",
        ready: "http://localhost:4200",
        check: ["GET /api/health -> 200"],
        max_attempts: 5,
        timeout: 4,
      },
    })!
    for (const part of [
      "- build: `npm run build`",
      "- test: `npm test`",
      "- start (in the background): `npm run dev`",
      "- ready when this answers: http://localhost:4200",
      "- check: GET /api/health -> 200",
      "up to 5 attempts",
      "about 4 minutes",
    ])
      expect(text).toContain(part)
    expect(text).not.toContain("${")
    const plain = buildProof({ name: "build", permission: [] })!
    expect(plain).toContain("up to 3 attempts")
    expect(plain).toContain("about 10 minutes")
    expect(plain).not.toContain("This project pins")
  })

  test("agent.build.verify: false restores handing back without verifying", () => {
    expect(
      buildProof({ name: "build", permission: [] }, undefined, { agent: { build: { verify: false } } }),
    ).toBeUndefined()
    expect(
      buildProof({ name: "build", permission: [] }, undefined, { agent: { build: { verify: true } } }),
    ).toBeDefined()
  })

  test("an organisation can lock verify and agent.build.verify", () => {
    expect(ConfigPolicy.unknownKeys(["verify", "agent.build.verify"])).toEqual([])
    type Doc = { agent?: { build?: { verify?: boolean } }; verify?: { test?: string } }
    const user: Doc = { agent: { build: { verify: false } }, verify: { test: "echo skip" } }
    const managed = { agent: { build: { verify: true } }, verify: { test: "npm test" } }
    const next = ConfigPolicy.apply(user as Record<string, unknown>, managed, ["agent.build.verify", "verify"]) as Doc
    expect(next.agent?.build?.verify).toBe(true)
    expect(next.verify?.test).toBe("npm test")
    expect(buildProof({ name: "build", permission: [] }, undefined, next)).toContain("`npm test`")
  })

  test("the process tool goes with the shell permission", () => {
    expect(Permission.disabled(["process"], Permission.fromConfig({ bash: "deny" })).has("process")).toBe(true)
    expect(Permission.disabled(["process"], Permission.fromConfig({ bash: "allow" })).has("process")).toBe(false)
  })
})
