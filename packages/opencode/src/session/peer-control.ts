export * as SessionPeerControl from "./peer-control"

import { randomBytes, timingSafeEqual } from "crypto"
import { createServer, type Server as HttpServer } from "node:http"
import { SessionLive } from "./live"
import { SessionPeers } from "./peers"

/**
 * XCOD-234: stop and answer sessions that another Lunos process on this machine runs. Each process
 * that has active sessions listens on 127.0.0.1 only, on a random port, and accepts a short, fixed
 * list of actions authorised by a random token. The port and token are in that process's 0600 file
 * under the user's data directory (SessionPeers), so only the same OS user can reach it.
 *
 * Every action is handed to the process's own HTTP API (`session.abort`, `permission.reply`,
 * `question.reply` / `reject`), the same calls its own window makes: a permission answered from
 * another window is checked and audited (`permission.decision`) by the process that asked.
 *
 * Requests that carry an `Origin` header (a web page in a browser) are refused, the response has no
 * CORS headers, and only requests addressed to 127.0.0.1 are served.
 */

/** The process's own API: how a forwarded action reaches its session, permission and question routes. */
export type Handler = (request: Request) => Promise<Response>

let handler: Handler | undefined
let server: HttpServer | undefined
let token: string | undefined

const defaultHandler: Handler = async (request) => {
  const [{ Server }, { ServerAuth }] = await Promise.all([import("@/server/server"), import("@/server/auth")])
  const headers = new Headers(request.headers)
  const auth = ServerAuth.header()
  if (auth) headers.set("authorization", auth)
  // A process that listens (`lunos serve`, the desktop app) runs its sessions in that listener's
  // services; Server.Default() would be a second, empty copy. The TUI and `lunos run` run them in
  // Server.Default().
  if (Server.url) {
    const url = new URL(request.url)
    return fetch(new URL(url.pathname + url.search, Server.url), {
      method: request.method,
      headers,
      ...(request.method !== "GET" ? { body: await request.text() } : {}),
      redirect: "error",
    })
  }
  return Server.Default().app.fetch(new Request(request, { headers }))
}

/** Tests: hand forwarded actions to `next` instead of this process's API. */
export function useHandler(next: Handler | undefined) {
  handler = next
}

function authorised(header: string | null) {
  const given = /^Bearer ([a-f0-9]{64})$/.exec(header ?? "")?.[1]
  if (!given || !token) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(token))
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function inner(path: string, directory: string, init: RequestInit = {}) {
  const url = new URL(`http://lunos.internal${path}`)
  url.searchParams.set("directory", directory)
  return (handler ?? defaultHandler)(
    new Request(url, { ...init, headers: { "content-type": "application/json", ...init.headers } }),
  )
}

async function forward(response: Response) {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json" },
  })
}

/** The routes another process may call. Anything else is a 404. */
export async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.headers.get("origin") !== null) return json(403, { error: "Not from a browser." })
  if (url.hostname !== "127.0.0.1") return json(403, { error: "Loopback only." })
  if (!authorised(request.headers.get("authorization"))) return json(401, { error: "Unauthorised." })

  const match = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,100})(\/.*)$/.exec(url.pathname)
  if (!match) return json(404, { error: "No such route." })
  const sessionID = match[1]!
  const rest = match[2]!
  const directory = SessionLive.directoryOf(sessionID)
  if (!directory) return json(404, { error: "This process isn't running that session." })

  if (rest === "/stop" && request.method === "POST")
    return forward(await inner(`/session/${sessionID}/abort`, directory, { method: "POST" }))
  if (rest === "/asks" && request.method === "GET") {
    const [permissions, questions] = await Promise.all(
      ["/permission", "/question"].map(async (path) => {
        const response = await inner(path, directory)
        const list = response.ok ? ((await response.json()) as Array<{ sessionID?: string }>) : []
        return list.filter((item) => item.sessionID === sessionID)
      }),
    )
    return json(200, { permissions, questions })
  }
  const answer = /^\/(permission|question)\/([A-Za-z0-9_-]{1,100})\/(reply|reject)$/.exec(rest)
  if (answer && request.method === "POST" && !(answer[1] === "permission" && answer[3] === "reject")) {
    // Only an ask this session made: the owning process checks the id belongs to it.
    const pending = await inner(`/${answer[1]}`, directory)
    const list = pending.ok ? ((await pending.json()) as Array<{ id?: string; sessionID?: string }>) : []
    if (!list.some((item) => item.id === answer[2] && item.sessionID === sessionID))
      return json(404, { error: "No such request for this session." })
    const body = await request.text()
    return forward(
      await inner(`/${answer[1]}/${answer[2]}/${answer[3]}`, directory, { method: "POST", body: body || "null" }),
    )
  }
  return json(404, { error: "No such route." })
}

/**
 * Starts listening (once) and records the endpoint in this process's file. node:http, not Bun.serve:
 * the desktop app runs this server in Node.
 */
export function start() {
  if (server) return
  token = randomBytes(32).toString("hex")
  const listener = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(key, value)
        else if (Array.isArray(value)) headers.set(key, value.join(", "))
      const host = req.headers.host ?? "127.0.0.1"
      const response = await serve(
        new Request(`http://${host}${req.url ?? "/"}`, {
          method: req.method,
          headers,
          ...(body.length && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
        }),
      )
      res.writeHead(response.status, { "content-type": "application/json" })
      res.end(await response.text())
    } catch {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "Failed." }))
    }
  })
  listener.unref()
  server = listener
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address()
    if (address && typeof address === "object" && token) SessionPeers.setControl({ port: address.port, token })
  })
}

export function stop() {
  server?.close()
  server = undefined
  token = undefined
  SessionPeers.setControl(undefined)
}

export class PeerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The window's side: send an action to the process that runs `sessionID`. Throws PeerError(404)
 * when no live process has it (it finished, or its Lunos closed).
 */
export async function call(sessionID: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const peer = SessionPeers.read().get(sessionID)
  if (!peer?.fresh || !peer.control) throw new PeerError(404, "No running Lunos has that session any more.")
  const response = await fetch(`http://127.0.0.1:${peer.control.port}/v1/sessions/${sessionID}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${peer.control.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  }).catch((error) => {
    throw new PeerError(
      502,
      `The Lunos running that session didn't answer: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : undefined
  if (!response.ok) throw new PeerError(response.status, body?.error ?? body?.message ?? `${response.status}`)
  return body
}
