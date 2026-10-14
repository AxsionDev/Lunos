// XCOD-185: stands in for the control plane's session-sync routes in tests (lunos-web plan
// 2026-10-14, Global Constraints): devices, chunk upload and session status, plus the OIDC
// discovery `CloudAuth.session()` reads, under `/oidc`. Chunks must arrive in order
// (`seq === lastSeq + 1`), an identical re-send is a duplicate, a different body at a stored seq is a
// chunk_conflict. Like the real one, out_of_order says where it stands only in the message prose.
//
// Test-only switches: `fail` answers chunk uploads with an error (the next `times` of them, if set), `deleted` marks a session deleted
// in the app, `device(id).syncEnabled = false` is the app's switch, `forget()` loses every stored
// chunk (a control plane restored from an older backup), `stop()`/`start()` take it off the network
// and back on the same port.

import { createHash } from "crypto"

export const TOKEN = "test-sync-token"
export const SUB = "user-1"
export const LIMIT = 4 * 1024 * 1024

export type Device = {
  id: string
  name: string
  platform: string
  syncEnabled: boolean
  lastSyncAt?: number
  createdAt: number
  revokedAt?: number
}
type Stored = { lastSeq: number; chunks: Map<number, string>; deleted?: boolean }

export function start(options: { port?: number } = {}) {
  const devices: Device[] = []
  const sessions = new Map<string, Stored>()
  const requests: Array<{ method: string; path: string; auth: string | null; body: string }> = []
  let server: ReturnType<typeof Bun.serve> | undefined
  let port = options.port ?? 0

  const error = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status })
  const sha = (s: string) => createHash("sha256").update(s).digest("hex")
  const stored = (s: string) => {
    let entry = sessions.get(s)
    if (!entry) sessions.set(s, (entry = { lastSeq: 0, chunks: new Map() }))
    return entry
  }

  const plane = {
    requests,
    devices,
    sessions,
    fail: undefined as { status: number; code: string; message?: string; times?: number } | undefined,
    get url() {
      return `http://127.0.0.1:${port}`
    },
    get issuer() {
      return `${plane.url}/oidc`
    },
    device(id?: string) {
      return id ? devices.find((d) => d.id === id) : devices.at(-1)
    },
    deleted(session: string) {
      stored(session).deleted = true
    },
    /** The PUT bodies received, raw, in order. */
    uploads() {
      return requests.filter((r) => r.method === "PUT").map((r) => r.body)
    },
    /** Message ids the space holds for `session`, in order of arrival, without repeats. */
    messages(session: string) {
      const ids: string[] = []
      for (const [, body] of [...(sessions.get(session)?.chunks ?? [])].sort((a, b) => a[0] - b[0]))
        for (const m of JSON.parse(body).messages) if (!ids.includes(m.info.id)) ids.push(m.info.id)
      return ids
    },
    forget() {
      for (const [, s] of sessions) {
        s.lastSeq = 0
        s.chunks.clear()
      }
    },
    start() {
      server = Bun.serve({ port, hostname: "127.0.0.1", fetch: handle })
      port = server.port!
      return plane
    },
    stop() {
      server?.stop(true)
      server = undefined
    },
  }

  async function handle(req: Request) {
    const url = new URL(req.url)
    const body = await req.text()
    requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body })
    if (url.pathname === "/oidc/.well-known/openid-configuration")
      return Response.json({
        issuer: plane.issuer,
        device_authorization_endpoint: `${plane.issuer}/device`,
        token_endpoint: `${plane.issuer}/token`,
      })
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return error(401, "unauthorized", "Sign in again.")

    if (req.method === "POST" && url.pathname === "/v1/devices") {
      const input = JSON.parse(body)
      const d: Device = {
        id: `dev_${devices.length + 1}`,
        name: input.name,
        platform: input.platform,
        syncEnabled: true,
        createdAt: Date.now(),
      }
      devices.push(d)
      return Response.json(d, { status: 201 })
    }
    if (req.method === "GET" && url.pathname === "/v1/devices") return Response.json({ devices })
    const patch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/)
    if (req.method === "PATCH" && patch) {
      const d = plane.device(decodeURIComponent(patch[1]!))
      if (!d) return error(404, "not_found", "No such device.")
      Object.assign(d, { syncEnabled: JSON.parse(body).syncEnabled })
      return Response.json(d)
    }

    const route = url.pathname.match(/^\/v1\/sync\/devices\/([^/]+)\/sessions\/([^/]+)(?:\/chunks\/(\d+))?$/)
    if (!route) return error(404, "not_found", "No such route.")
    const device = plane.device(decodeURIComponent(route[1]!))
    if (!device || device.revokedAt) return error(403, "device_revoked", "This device was removed.")
    const session = decodeURIComponent(route[2]!)
    const entry = stored(session)
    if (req.method === "GET" && route[3] === undefined)
      return Response.json({ session, lastSeq: entry.lastSeq, ...(entry.deleted ? { deleted: true } : {}) })
    if (req.method !== "PUT" || route[3] === undefined) return error(405, "method_not_allowed", "No.")

    if (plane.fail && (plane.fail.times === undefined || plane.fail.times-- > 0))
      return error(plane.fail.status, plane.fail.code, plane.fail.message ?? plane.fail.code)
    if (!device.syncEnabled) return error(409, "sync_disabled", "Sync is off for this device.")
    if (entry.deleted) return error(410, "session_deleted", "This session was deleted.")
    if (Buffer.byteLength(body) > LIMIT) return error(413, "too_large", "Chunks are at most 4 MiB.")
    const seq = Number(route[3])
    const existing = entry.chunks.get(seq)
    if (existing !== undefined) {
      if (sha(existing) !== sha(body))
        return error(409, "chunk_conflict", `Chunk ${seq} is already stored with other content.`)
      return Response.json({ session, seq, lastSeq: entry.lastSeq, duplicate: true })
    }
    if (seq !== entry.lastSeq + 1)
      return error(409, "out_of_order", `Send chunk ${entry.lastSeq + 1} next (last stored: ${entry.lastSeq}).`)
    entry.chunks.set(seq, body)
    entry.lastSeq = seq
    device.lastSyncAt = Date.now()
    return Response.json({ session, seq, lastSeq: seq, duplicate: false })
  }

  return plane.start()
}

export type FakeSyncPlane = ReturnType<typeof start>
