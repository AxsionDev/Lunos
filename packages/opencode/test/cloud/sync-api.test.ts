import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { CloudSyncApi } from "@/cloud/sync-api"

let server: ReturnType<typeof Bun.serve>
let seen: Array<{ method: string; path: string; auth: string | null; body: string }>
let devices: any[]
let tmp: string
const original = Global.Path.data

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sync-api-"))
  ;(Global.Path as any).data = tmp
  seen = []
  devices = []
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.text()
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body })
      if (req.method === "POST" && url.pathname === "/v1/devices") {
        const d = { id: `dev_${devices.length + 1}`, ...JSON.parse(body), syncEnabled: true, createdAt: 1 }
        devices.push(d)
        return Response.json(d, { status: 201 })
      }
      if (req.method === "GET" && url.pathname === "/v1/devices") return Response.json({ devices })
      if (req.method === "PATCH") {
        const d = devices.find((x) => url.pathname.endsWith(x.id))
        Object.assign(d, JSON.parse(body))
        return Response.json(d)
      }
      if (req.method === "PUT" && url.pathname.includes("/chunks/2"))
        return Response.json({ error: { code: "out_of_order", message: "Send chunk 1 next (last stored: 0)." } }, { status: 409 })
      if (req.method === "PUT") return Response.json({ session: "s", seq: 1, lastSeq: 1, duplicate: false })
      return new Response("no", { status: 404 })
    },
  })
})
afterEach(() => { server.stop(true); (Global.Path as any).data = original })

const opts = () => ({ token: async () => "tok", endpoint: `http://127.0.0.1:${server.port}`, sub: "u1" })

test("register once, reuse after", async () => {
  const a = await CloudSyncApi.register(opts())
  const b = await CloudSyncApi.register(opts())
  expect(a.device.id).toBe(b.device.id)
  expect(seen.filter((r) => r.method === "POST")).toHaveLength(1)
  expect(seen[0]!.auth).toBe("Bearer tok")
  expect(JSON.parse(seen[0]!.body).platform).toBe(process.platform)
})

test("a revoked device is replaced", async () => {
  const a = await CloudSyncApi.register(opts())
  devices[0].revokedAt = 5
  const b = await CloudSyncApi.register(opts())
  expect(b.device.id).not.toBe(a.device.id)
})

test("upload maps success and errors", async () => {
  const s = await CloudSyncApi.register(opts())
  expect(await CloudSyncApi.upload(s, "ses_1", 1, "{\"messages\":[]}", opts())).toEqual({ ok: true, lastSeq: 1, duplicate: false })
  const bad = await CloudSyncApi.upload(s, "ses_1", 2, "{\"messages\":[]}", opts())
  expect(bad).toMatchObject({ ok: false, status: 409, code: "out_of_order" })
  expect((bad as { lastSeq?: number }).lastSeq).toBeUndefined()
})

test("project config cannot move the endpoint", async () => {
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "proj-"))
  await fs.writeFile(path.join(proj, "opencode.json"), JSON.stringify({ cloud: { endpoint: "https://evil.example" } }))
  const cwd = process.cwd()
  process.chdir(proj)
  try { expect(await CloudSyncApi.endpoint()).toBe("https://cloud.lunos.tech") } finally { process.chdir(cwd) }
})

test("global config sets the endpoint; a non-https remote is refused", async () => {
  const file = path.join(Global.Path.config, "opencode.json")
  await fs.mkdir(Global.Path.config, { recursive: true })
  try {
    await fs.writeFile(file, JSON.stringify({ cloud: { endpoint: "https://cloud.example.org/" } }))
    expect(await CloudSyncApi.endpoint()).toBe("https://cloud.example.org")
    await fs.writeFile(file, JSON.stringify({ cloud: { endpoint: "http://cloud.example.org" } }))
    await expect(CloudSyncApi.endpoint()).rejects.toThrow("https")
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("status reads lastSeq", async () => {
  const s = await CloudSyncApi.register(opts())
  server.stop(true)
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ session: "s", lastSeq: 3, deleted: true }) })
  expect(await CloudSyncApi.status({ ...s, endpoint: `http://127.0.0.1:${server.port}` }, "ses_1", opts())).toEqual({ ok: true, lastSeq: 3, deleted: true })
})

test("network failures, timeouts and bad JSON are results, never thrown", async () => {
  const s = await CloudSyncApi.register(opts())
  server.stop(true)
  const dead = { ...s, endpoint: `http://127.0.0.1:${server.port}` }
  expect(await CloudSyncApi.upload(dead, "ses_1", 1, "{}", opts())).toMatchObject({ ok: false, status: 0, code: "network" })
  expect(await CloudSyncApi.status(dead, "ses_1", opts())).toMatchObject({ ok: false, status: 0, code: "network" })
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not json", { status: 200 }) })
  const garbled = { ...s, endpoint: `http://127.0.0.1:${server.port}` }
  expect(await CloudSyncApi.upload(garbled, "ses_1", 1, "{}", opts())).toMatchObject({ ok: false, status: 0, code: "network" })
  server.stop(true)
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) })
  const slow = { ...s, endpoint: `http://127.0.0.1:${server.port}` }
  expect(await CloudSyncApi.upload(slow, "ses_1", 1, "{}", { ...opts(), timeoutMs: 100 })).toMatchObject({ ok: false, status: 0, code: "network" })
})

test("device.json is written 0600 in a 0700 directory", async () => {
  if (process.platform === "win32") return
  await fs.mkdir(path.dirname(CloudSyncApi.file()), { recursive: true, mode: 0o755 })
  await fs.chmod(path.dirname(CloudSyncApi.file()), 0o755)
  await CloudSyncApi.register(opts())
  expect((await fs.stat(path.dirname(CloudSyncApi.file()))).mode & 0o777).toBe(0o700)
  expect((await fs.stat(CloudSyncApi.file())).mode & 0o777).toBe(0o600)
  expect((await fs.readdir(path.dirname(CloudSyncApi.file()))).filter((n) => n.endsWith(".tmp"))).toEqual([])
})
