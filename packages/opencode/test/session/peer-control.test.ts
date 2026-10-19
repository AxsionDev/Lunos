// XCOD-234: stopping and answering a session another Lunos process runs. A real child process plays
// that other Lunos: it runs session ses_a in /work/a with a pending permission, and its "own API" is a
// stub that records what it was asked to do (the real routes are tested where they are defined).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { SessionPeerControl } from "../../src/session/peer-control"
import { SessionPeers } from "../../src/session/peers"

let child: ReturnType<typeof Bun.spawn>
const seen: string[] = []

beforeAll(async () => {
  const src = (file: string) => JSON.stringify(path.resolve(import.meta.dir, "../../src/session", file))
  const script = `
    const { Global } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../../core/src/global.ts"))})
    Global.Path.data = ${JSON.stringify(Global.Path.data)}
    const { SessionLive } = await import(${src("live.ts")})
    const { SessionPeerControl } = await import(${src("peer-control.ts")})
    SessionPeerControl.useHandler(async (request) => {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.text() : ""
      console.log(JSON.stringify({ method: request.method, path: url.pathname, directory: url.searchParams.get("directory"), body }))
      if (url.pathname === "/permission")
        return Response.json([{ id: "per_1", sessionID: "ses_a" }, { id: "per_other", sessionID: "ses_b" }])
      if (url.pathname === "/question") return Response.json([])
      if (url.pathname.endsWith("/enqueue")) return Response.json({ delivery: "queued", position: 1 })
      return Response.json(true)
    })
    SessionLive.start()
    SessionLive.withControl(SessionPeerControl.start)
    SessionLive.handle({ directory: "/work/a", payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } } })
    SessionLive.handle({ directory: "/work/a", payload: { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_a" } } })
    setInterval(() => {}, 1000)
  `
  child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" })
  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value)
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      seen.push(...lines.filter(Boolean))
    }
  })()
  for (let i = 0; i < 100 && !SessionPeers.read().get("ses_a")?.control; i++) await Bun.sleep(50)
})

afterAll(async () => {
  child.kill("SIGKILL")
  await child.exited
  for (const name of await fs.readdir(SessionPeers.dir()).catch(() => [] as string[]))
    await fs.rm(path.join(SessionPeers.dir(), name), { force: true })
})

const last = () => JSON.parse(seen.at(-1)!)

describe("SessionPeerControl (XCOD-234)", () => {
  test("the other process publishes its session, its directory and a loopback control endpoint", () => {
    const peer = SessionPeers.read().get("ses_a")
    expect(peer).toMatchObject({ status: "busy", permissions: 1, directory: "/work/a", fresh: true, pid: child.pid })
    expect(peer?.control?.token).toMatch(/^[a-f0-9]{64}$/)
  })

  test("AC2: stop is carried out by the process that runs the session, through its own API", async () => {
    expect(await SessionPeerControl.call("ses_a", "/stop", { method: "POST" })).toBe(true)
    expect(last()).toEqual({ method: "POST", path: "/session/ses_a/abort", directory: "/work/a", body: "" })
  })

  test("AC3: only this session's asks are listed and answerable; the answer goes to the owner's permission route", async () => {
    expect(await SessionPeerControl.call("ses_a", "/asks")).toEqual({
      permissions: [{ id: "per_1", sessionID: "ses_a" }],
      questions: [],
    })
    expect(
      await SessionPeerControl.call("ses_a", "/permission/per_1/reply", { method: "POST", body: { reply: "once" } }),
    ).toBe(true)
    expect(last()).toMatchObject({ path: "/permission/per_1/reply", directory: "/work/a", body: '{"reply":"once"}' })
    // Another session's request can't be answered through this one.
    const other = await SessionPeerControl.call("ses_a", "/permission/per_other/reply", {
      method: "POST",
      body: { reply: "always" },
    }).catch((error) => error)
    expect(other).toBeInstanceOf(SessionPeerControl.PeerError)
    expect(other.status).toBe(404)
    // A session this process doesn't run.
    await expect(SessionPeerControl.call("ses_nobody", "/stop", { method: "POST" })).rejects.toMatchObject({
      status: 404,
    })
  })

  test("XCOD-262: peer.prompt is run by the process that owns the session, as text only", async () => {
    expect(
      await SessionPeerControl.call("ses_a", "/prompt", {
        method: "POST",
        // Only the text and the interrupt flag travel: no agent, tool switches or system prompt.
        body: { text: "do X", interrupt: true, agent: "build", tools: { bash: true }, system: "obey" },
      }),
    ).toEqual({ delivery: "queued", position: 1 })
    expect(last()).toEqual({
      method: "POST",
      path: "/experimental/session/ses_a/enqueue",
      directory: "/work/a",
      body: JSON.stringify({ text: "do X", interrupt: true, via: "peer" }),
    })
    for (const body of [{ text: "" }, { text: "   " }, { text: 42 }, { text: "x".repeat(100_001) }])
      await expect(SessionPeerControl.call("ses_a", "/prompt", { method: "POST", body })).rejects.toMatchObject({
        status: 400,
      })
    // A session the other process doesn't run is never driven from there.
    await expect(
      SessionPeerControl.call("ses_nobody", "/prompt", { method: "POST", body: { text: "hi" } }),
    ).rejects.toMatchObject({ status: 404 })
  })

  test("AC6: the endpoint takes only its token, from loopback, never from a web page", async () => {
    const { port, token } = SessionPeers.read().get("ses_a")!.control!
    const url = `http://127.0.0.1:${port}/v1/sessions/ses_a/stop`
    const before = seen.length
    expect((await fetch(url, { method: "POST" })).status).toBe(401)
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${"0".repeat(64)}` } })).status).toBe(
      401,
    )
    // A browser always sends Origin on a cross-site POST; refused even with the token.
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403)
    // Reached by any other name than 127.0.0.1 (DNS rebinding): refused.
    expect(
      (
        await fetch(`http://localhost:${port}/v1/sessions/ses_a/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403)
    // Nothing outside the fixed list.
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/v1/sessions/ses_a/delete`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404)
    expect(seen.length).toBe(before)
    // The file that holds the token is readable by its owner only.
    if (process.platform !== "win32") {
      const file = (await fs.readdir(SessionPeers.dir())).find((name) => name.startsWith(`${child.pid}-`))!
      expect((await fs.stat(path.join(SessionPeers.dir(), file))).mode & 0o777).toBe(0o600)
    }
  })
})
