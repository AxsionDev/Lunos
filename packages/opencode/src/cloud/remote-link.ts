export * as CloudRemoteLink from "./remote-link"

/**
 * XCOD-338: the computer's side of the remote control relay on Lunos Cloud (lunoshq
 * `src/remote/http.ts`). Plain `fetch`, outbound only: this module never listens on a port. It has no
 * imports, so the control plane's end-to-end test runs it as is.
 *
 * - `open` asks the relay for a link to one session and gets the link's host secret, which only this
 *   process holds; every later call carries it in `x-lunos-remote-host`.
 * - `push` posts what the session did (already redacted by the caller).
 * - `collect` long-polls for the commands the user sent from the web; it is the heartbeat too: a link
 *   whose computer stops polling ends on the relay within 90 s.
 * - `close` ends the link.
 *
 * A `410` from any call means the link is over (revoked on the web, expired after 12 hours, the
 * device revoked or its sync switched off): `LinkEndedError`.
 */

export const HOST_HEADER = "x-lunos-remote-host"
/** The long poll's wait, in seconds; the relay caps it at 25. */
export const WAIT_SECONDS = 25

export type Options = {
  endpoint: string
  token: () => Promise<string>
  fetch?: typeof fetch
}

export type Link = {
  id: string
  host: string
  session: string
  device: string
  createdAt: number
  expiresAt: number
}

export type Command =
  | { id: string; at: number; type: "prompt"; text: string; queue: boolean }
  | {
      id: string
      at: number
      type: "permission"
      requestID: string
      reply: "once" | "always" | "reject"
      message?: string
    }
  | { id: string; at: number; type: "question"; requestID: string; answers?: string[][]; reject?: boolean }
  | { id: string; at: number; type: "stop" }
  | { id: string; at: number; type: "interrupt" }

export type Event = { type: string; key?: string; data: unknown }

export class LinkEndedError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message)
  }
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call(opts: Options, method: string, path: string, init: { body?: unknown; host?: string; timeoutMs?: number } = {}) {
  const res = await (opts.fetch ?? fetch)(opts.endpoint.replace(/\/+$/, "") + path, {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${await opts.token()}`,
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.host ? { [HOST_HEADER]: init.host } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  })
  const json = (await res.json().catch(() => undefined)) as any
  if (res.status === 410) throw new LinkEndedError(json?.error?.message ?? "The remote session ended.", json?.error?.details?.reason)
  if (!res.ok)
    throw new RelayError(res.status, json?.error?.code ?? `http_${res.status}`, json?.error?.message ?? `HTTP ${res.status}`)
  return json
}

export async function open(opts: Options, input: { device: string; session: string; title?: string }): Promise<Link> {
  const json = await call(opts, "POST", "/v1/remote/links", { body: input })
  return {
    id: json.id,
    host: json.host,
    session: json.session,
    device: json.device,
    createdAt: json.createdAt,
    expiresAt: json.expiresAt,
  }
}

export async function push(opts: Options, link: Link, events: Event[]) {
  if (!events.length) return
  await call(opts, "POST", `/v1/remote/links/${link.id}/events`, { body: { events }, host: link.host })
}

export async function collect(opts: Options, link: Link, wait = WAIT_SECONDS): Promise<Command[]> {
  const json = await call(opts, "GET", `/v1/remote/links/${link.id}/commands?wait=${wait}`, {
    host: link.host,
    timeoutMs: (wait + 15) * 1000,
  })
  return Array.isArray(json?.commands) ? json.commands : []
}

export async function close(opts: Options, link: Link) {
  await call(opts, "DELETE", `/v1/remote/links/${link.id}`, { host: link.host, timeoutMs: 5_000 }).catch(() => undefined)
}
