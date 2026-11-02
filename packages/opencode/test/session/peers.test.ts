// XCOD-234: how Lunos processes on one machine share what their sessions are doing. Each one writes
// a file under the user's data directory; the Sessions window reads the others'. A real second
// process (a Bun child running SessionPeers.publish) stands in for another Lunos.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { existsSync, statSync } from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { SessionPeers } from "../../src/session/peers"

const peerFile = (name: string) => path.join(SessionPeers.dir(), `${name}.json`)
const claim = { status: "busy" as const, permissions: 0, questions: 0 }

afterEach(async () => {
  SessionPeers.reset()
  // Files only: a watcher another test (or the server) holds on the directory must keep working.
  for (const name of await fs.readdir(SessionPeers.dir()).catch(() => [] as string[]))
    await fs.rm(path.join(SessionPeers.dir(), name), { force: true })
})

/** Another Lunos: a child process that publishes `sessions` and keeps heartbeating until killed. */
async function otherProcess(sessions: Record<string, unknown>) {
  const script = `
    const { Global } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../../core/src/global.ts"))})
    Global.Path.data = ${JSON.stringify(Global.Path.data)}
    const { SessionPeers } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/peers.ts"))})
    SessionPeers.publish(${JSON.stringify(sessions)})
    console.log("published")
    setInterval(() => {}, 1000)
  `
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" })
  const reader = child.stdout.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toContain("published")
  return child
}

describe("SessionPeers (XCOD-234)", () => {
  test("publishes this process's active sessions in a file only the user can read, and removes it when idle", async () => {
    SessionPeers.publish({ ses_a: claim })
    const file = SessionPeers.own()
    expect(existsSync(file)).toBe(true)
    const body = JSON.parse(await fs.readFile(file, "utf8"))
    expect(body).toMatchObject({ version: 1, pid: process.pid, sessions: { ses_a: claim } })
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(SessionPeers.dir()).mode & 0o777).toBe(0o700)
    }
    // Its own file isn't read back as another process's.
    expect(SessionPeers.read().size).toBe(0)
    SessionPeers.publish({})
    expect(existsSync(file)).toBe(false)
  })

  test("AC1/AC5: another process's sessions are live while it heartbeats, and stale once it's killed with -9", async () => {
    const child = await otherProcess({ ses_other: claim, ses_ask: { permissions: 1, questions: 0 } })
    try {
      const live = SessionPeers.read()
      expect(live.get("ses_other")).toEqual({ ...claim, fresh: true, pid: child.pid })
      expect(live.get("ses_ask")).toEqual({
        status: undefined,
        permissions: 1,
        questions: 0,
        fresh: true,
        pid: child.pid,
      })
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
    // kill -9 runs no exit hook: the file stays, and its heartbeat stops.
    const left = (await fs.readdir(SessionPeers.dir())).filter((name) => name.startsWith(`${child.pid}-`))
    expect(left).toHaveLength(1)
    const later = Date.now() + SessionPeers.STALE_MS + 1
    expect(SessionPeers.read({ now: later }).get("ses_other")?.fresh).toBe(false)
  })

  test("a fresh claim wins over a stale one, malformed files are ignored, and long-dead files are removed", async () => {
    await fs.mkdir(SessionPeers.dir(), { recursive: true, mode: 0o700 })
    const now = Date.now()
    await fs.writeFile(
      peerFile("1-dead"),
      JSON.stringify({ version: 1, pid: 1, heartbeat: now - 60_000, sessions: { ses_x: claim } }),
    )
    await fs.writeFile(
      peerFile("2-live"),
      JSON.stringify({ version: 1, pid: 2, heartbeat: now, sessions: { ses_x: { permissions: 2, questions: 0 } } }),
    )
    await fs.writeFile(peerFile("3-junk"), "{not json")
    await fs.writeFile(
      peerFile("4-gone"),
      JSON.stringify({ version: 1, pid: 4, heartbeat: now - 2 * 60 * 60 * 1000, sessions: { ses_y: claim } }),
    )
    const peers = SessionPeers.read({ now })
    expect(peers.get("ses_x")).toMatchObject({ fresh: true, pid: 2, permissions: 2 })
    expect(peers.has("ses_y")).toBe(false)
    expect(existsSync(peerFile("4-gone"))).toBe(false)
  })

  test("subscribers hear about another process's change", async () => {
    let calls = 0
    const off = SessionPeers.subscribe(() => calls++)
    try {
      const child = await otherProcess({ ses_other: claim })
      child.kill("SIGKILL")
      await child.exited
      for (let i = 0; i < 100 && calls === 0; i++) await Bun.sleep(50)
      expect(calls).toBeGreaterThan(0)
    } finally {
      off()
    }
  })
})
