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
 * `question.reply` / `reject`, `session.update` for a rename), the same calls its own window makes:
 * a permission answered from another window is checked and audited (`permission.decision`) by the
 * process that asked.
 *
 * Requests that carry an `Origin` header (a web page in a browser) are refused, the response has no
 * CORS headers, and only requests addressed to 127.0.0.1 are served.
 */

/** The process's own API: how a forwarded action reaches its session, permission and question routes. */
export type Handler = (request: Request) => Promise<Response>

/** XCOD-262: the longest prompt the Agent Monitor sends, here or to another process. */
export const MAX_PROMPT = 100_000

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

/** XCOD-262: a call to this process's own API, as a forwarded action makes it (SessionPromptQueue). */
export const api = inner

async function forward(response: Response) {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json" },
  })
}

/** XCOD-265: what a stopped session's pending approvals are rejected with, unless the caller says otherwise. */
export const STOP_REASON = "Stopped from /sessions"

/** An answer to a request this process may have already settled: a 404 means it's gone, which is fine. */
async function settled(response: Response, what: string) {
  if (response.ok || response.status === 404) return
  throw new PeerError(response.status, `Couldn't reject ${what}: ${(await response.text()) || response.status}`)
}

async function pending(path: "/permission" | "/question", sessionID: string, directory: string) {
  const response = await inner(path, directory)
  if (!response.ok) throw new PeerError(response.status, `Couldn't list the session's pending ${path.slice(1)}s`)
  const list = (await response.json()) as Array<{ id?: string; sessionID?: string }>
  return list.filter((item) => item.sessionID === sessionID && typeof item.id === "string") as { id: string }[]
}

/**
 * XCOD-265: rejects the session's pending approvals and questions first, so no tool is left waiting
 * on an answer that can't come, then aborts the turn (background subagents stop with it). Aborting
 * alone would drop the asks without a reply event, so if a rejection fails the turn is not aborted
 * and the stop is reported as failed.
 */
async function stopIn(sessionID: string, directory: string, reason: string) {
  // One rejection with a message rejects the session's other pending approvals too.
  const [permission] = await pending("/permission", sessionID, directory)
  if (permission)
    await settled(
      await inner(`/permission/${permission.id}/reply`, directory, {
        method: "POST",
        body: JSON.stringify({ reply: "reject", message: reason }),
      }),
      "its pending approval",
    )
  // A question can't carry a reason: it is rejected as "dismissed".
  for (const question of await pending("/question", sessionID, directory))
    await settled(
      await inner(`/question/${question.id}/reject`, directory, { method: "POST", body: "null" }),
      "its pending question",
    )
  return inner(`/session/${sessionID}/abort`, directory, { method: "POST" })
}

/** XCOD-265: stops a session this process runs. Throws PeerError(404) when it runs none by that id. */
export async function stopHere(sessionID: string, reason = STOP_REASON) {
  const directory = SessionLive.directoryOf(sessionID)
  if (!directory) throw new PeerError(404, "This process isn't running that session.")
  const response = await stopIn(sessionID, directory, reason)
  if (!response.ok) throw new PeerError(response.status, (await response.text()) || `${response.status}`)
  return true
}

/**
 * XCOD-269: drops what this process holds queued for a session that was deleted (set by
 * SessionPromptQueue, which this module can't import). Returns how many went.
 */
export const hooks: { forget?: (sessionID: string) => number } = {}

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

  if (rest === "/stop" && request.method === "POST") {
    const body = (await request.json().catch(() => undefined)) as { reason?: unknown } | undefined
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.slice(0, 200) : STOP_REASON
    return stopIn(sessionID, directory, reason).then(forward, (error) =>
      json(error instanceof PeerError ? error.status : 500, {
        error: error instanceof Error ? error.message : "Failed.",
      }),
    )
  }
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
  // XCOD-262: a prompt from another process's Agent Monitor. Text only: no agent, tools, system
  // prompt or model override travel with it, and it can never answer a permission. The session
  // queue decides when it runs, with this process's own agent, policy and audit.
  if (rest === "/prompt" && request.method === "POST") {
    const body = (await request.json().catch(() => undefined)) as { text?: unknown; interrupt?: unknown } | undefined
    if (!body || typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_PROMPT)
      return json(400, { error: "A prompt is non-empty text." })
    return forward(
      await inner(`/experimental/session/${sessionID}/enqueue`, directory, {
        method: "POST",
        body: JSON.stringify({ text: body.text, interrupt: body.interrupt === true, via: "peer" }),
      }),
    )
  }
  // XCOD-325: a rename from another process's Sessions view. Stored once, by this process, through
  // its own session route: its views get the new name at once, and the rename is audited here.
  if (rest === "/rename" && request.method === "POST") {
    const body = (await request.json().catch(() => undefined)) as { title?: unknown } | undefined
    if (typeof body?.title !== "string" || body.title.length > 1_000)
      return json(400, { error: "A name is text (empty: the automatic name)." })
    return forward(
      await inner(`/session/${sessionID}`, directory, { method: "PATCH", body: JSON.stringify({ title: body.title }) }),
    )
  }
  // XCOD-269: the session was deleted in another process: its prompts queued here go too.
  if (rest === "/forget" && request.method === "POST") return json(200, { discarded: hooks.forget?.(sessionID) ?? 0 })
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
