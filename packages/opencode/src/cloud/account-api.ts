export * as CloudAccountApi from "./account-api"

import { Offline } from "@opencode-ai/core/offline"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-273: the account calls /account and the sign-in screen make to Lunos Cloud's control plane
 * (lunoshq), with the session's own token. Only for a sign-in Lunos Cloud may receive
 * (`CloudSyncApi.permitted`: Lunos's own issuer, or a configured `cloud.endpoint`), never offline.
 *
 * Served today (lunoshq src/server.ts, space/http.ts):
 *   GET    /v1/account           who, organisations with roles, devices
 *   DELETE /v1/account           the account's synced data and devices (the Keycloak identity stays)
 * Not served yet (XCOD-274); each answers NotServedError on 404 so the screen says so:
 *   GET  /v1/account                → `plan: { id, name }`   the plan the account is on
 *   PUT  /v1/account/consent        { terms, privacy }        the accepted Terms/Privacy version
 *   POST /v1/account/verification   (no body)                 send the confirmation e-mail again
 *   DELETE /v1/account              → `identity: "deleted" | "scheduled"`  the sign-in itself too
 */

export const TIMEOUT_MS = 10_000

export class NotServedError extends Error {
  override name = "CloudAccountNotServed"
  constructor(what: string) {
    super(`${what} isn't available from Lunos Cloud yet.`)
  }
}

export class RefusedError extends Error {
  override name = "CloudAccountRefused"
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type Options = { fetch?: typeof fetch; endpoint?: string; timeoutMs?: number }

export type Account = {
  sub?: string
  email?: string
  organizations: { org: string; role?: string }[]
  devices: { id: string; name: string; platform?: string; revokedAt?: number }[]
  plan?: { id: string; name: string }
}

/** Whether these calls may go out for a sign-in to `issuer`, and why not. */
export async function allowed(issuer: string): Promise<string | undefined> {
  if (Offline.enabled()) return "offline mode (LUNOS_OFFLINE) is on"
  if (!(await CloudSyncApi.permitted(issuer))) return "your sign-in is your organisation's, not a Lunos account"
}

async function call(token: string, method: string, path: string, body: unknown, what: string, opts: Options) {
  const base = opts.endpoint ?? (await CloudSyncApi.endpoint())
  const response = await (opts.fetch ?? fetch)(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A redirect must not carry the token somewhere else.
    redirect: "error",
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  })
  if (response.status === 404 || response.status === 405) throw new NotServedError(what)
  if (!response.ok) {
    const json = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    throw new RefusedError(response.status, json?.error?.message ?? `Lunos Cloud answered ${response.status}`)
  }
  if (response.status === 204) return undefined
  return response.json().catch(() => undefined) as Promise<unknown>
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)

export async function account(token: string, opts: Options = {}): Promise<Account> {
  const body = ((await call(token, "GET", "/v1/account", undefined, "Your account", opts)) ?? {}) as Record<
    string,
    unknown
  >
  const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : [])
  const plan = body.plan as Record<string, unknown> | undefined
  return {
    sub: text(body.sub),
    email: text(body.email),
    organizations: list(body.organizations)
      .filter((item) => text(item?.org))
      .map((item) => ({ org: String(item.org), role: text(item.role) })),
    devices: list(body.devices)
      .filter((item) => text(item?.id))
      .map((item) => ({
        id: String(item.id),
        name: text(item.name) ?? String(item.id),
        platform: text(item.platform),
        revokedAt: typeof item.revokedAt === "number" ? item.revokedAt : undefined,
      })),
    plan: plan && text(plan.name) ? { id: text(plan.id) ?? String(plan.name), name: String(plan.name) } : undefined,
  }
}

export async function consent(token: string, version: string, opts: Options = {}) {
  await call(token, "PUT", "/v1/account/consent", { terms: version, privacy: version }, "Recording your consent", opts)
}

export async function resendVerification(token: string, opts: Options = {}) {
  await call(token, "POST", "/v1/account/verification", undefined, "Sending the confirmation e-mail again", opts)
}

export type Deleted = { sessions?: number; devices?: number; identity?: "deleted" | "scheduled" }

export async function deleteAccount(token: string, opts: Options = {}): Promise<Deleted> {
  const body = ((await call(token, "DELETE", "/v1/account", undefined, "Deleting your account", opts)) ?? {}) as Record<
    string,
    unknown
  >
  return {
    sessions: typeof body.sessions === "number" ? body.sessions : undefined,
    devices: typeof body.devices === "number" ? body.devices : undefined,
    identity: body.identity === "deleted" || body.identity === "scheduled" ? body.identity : undefined,
  }
}
