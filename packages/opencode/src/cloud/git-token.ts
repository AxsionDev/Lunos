export * as CloudGitToken from "./git-token"

import { CloudAuth } from "./auth"
import { CloudStore } from "./store"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-243: store, replace or remove the git token Lunos Cloud clones and pushes with, for one host
 * (`PUT/DELETE /v1/account/git-credentials/{host}` on the control plane). Write-only: the control
 * plane never returns a token, and neither does this.
 *
 * It goes to the same control plane session sync uses: `cloud.endpoint` from global or managed config
 * (never a project's, so a repository can't collect your git token), else Lunos Cloud. An
 * organisation's own sign-in only goes to a control plane someone configured explicitly.
 */

export class GitTokenError extends Error {
  override name = "CloudGitTokenError"
}

const HOST = /^[a-z0-9.-]+(:\d+)?$/

/** A host as the control plane stores it: lower-case, no scheme, path or credentials. */
export function normaliseHost(input: string) {
  const host = input.trim().toLowerCase()
  if (!HOST.test(host))
    throw new GitTokenError(`"${input}" isn't a host name, e.g. github.com or gitlab.example.eu:8443.`)
  return host
}

export type Options = {
  fetch?: typeof fetch
  /** Tests: skip the stored session. */
  session?: { token: string; issuer: string }
  endpoint?: string
}

async function target(opts: Options) {
  const session = opts.session ?? (await signedIn())
  if (!(await CloudSyncApi.permitted(session.issuer)))
    throw new GitTokenError(
      "You're signed in to your organisation's identity provider, so Lunos needs to know your organisation's Lunos Cloud: set cloud.endpoint in your user config.",
    )
  return { token: session.token, base: opts.endpoint ?? (await CloudSyncApi.endpoint()) }
}

async function signedIn() {
  const stored = await CloudStore.load()
  if (!stored) throw new GitTokenError("Not signed in. Run lunos login first.")
  // Refreshed (with discovery) only when it's about to expire, as for the organisation's console.
  const expires = stored.tokens.expires_at
  if (expires === undefined || expires * 1000 > Date.now() + 30_000)
    return { token: stored.tokens.access_token, issuer: stored.issuer }
  const fresh = await CloudAuth.session("Storing a git token")
  return { token: fresh.tokens.access_token, issuer: stored.issuer }
}

async function send(method: "PUT" | "DELETE", host: string, body: unknown, opts: Options) {
  const { token, base } = await target(opts)
  const response = await (opts.fetch ?? fetch)(`${base}/v1/account/git-credentials/${encodeURIComponent(host)}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    throw new GitTokenError(
      `Can't reach Lunos Cloud at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  if (response.ok) return { base }
  const json = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
  throw new GitTokenError(
    json?.error?.message ?? `Lunos Cloud answered ${response.status} ${response.statusText}`.trim(),
  )
}

/** Stores (or replaces) the token for `host`. `username` is what git sends with it (GitHub: x-access-token). */
export async function set(input: { host: string; token: string; username?: string }, opts: Options = {}) {
  const host = normaliseHost(input.host)
  const token = input.token.trim()
  if (!token) throw new GitTokenError("The token is empty.")
  if (/\s/.test(token)) throw new GitTokenError("The token contains spaces or line breaks; paste only the token.")
  const { base } = await send("PUT", host, { token, ...(input.username ? { username: input.username } : {}) }, opts)
  return { host, base }
}

/** Removes the stored token for `host`. */
export async function remove(input: { host: string }, opts: Options = {}) {
  const host = normaliseHost(input.host)
  const { base } = await send("DELETE", host, undefined, opts)
  return { host, base }
}
