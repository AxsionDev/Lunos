export * as CloudSyncApi from "./sync-api"

import { randomUUID } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { CloudAuth } from "./auth"
import { CloudDefaults } from "./defaults"
import { CloudStore } from "./store"
import { CloudSyncQueue } from "./sync-queue"
import { ConfigPolicy } from "@/config/policy"
import { SandboxConfig } from "@/sandbox/config"

/**
 * Session sync's client for the control plane (lunos-web spec 2026-10-13 §3-4, C1, C4). The
 * endpoint comes from managed, then global config, never a project's: sync runs on its own with the
 * user's token, so a repository must not choose where it goes. The device's sync switch lives on
 * the server (C4); `device.json` caches it for offline starts.
 */
export type Device = {
  id: string
  name: string
  platform: string
  syncEnabled: boolean
  lastSyncAt?: number
  createdAt: number
  revokedAt?: number
}
export type State = { endpoint: string; sub: string; device: Device; noticeShown: boolean; paused?: "quota" }
export type Options = {
  fetch?: typeof fetch
  token?: () => Promise<string>
  endpoint?: string
  sub?: string
  /** Per request; 30 s by default. `lunos login` registers with a short one so it can't hang. */
  timeoutMs?: number
}
/**
 * A request that never reached an answer (network, timeout, a body that isn't JSON) is `status: 0`,
 * `code: "network"`; no sign-in is `status: 0`, `code: "signed_out"`. Neither is thrown: sync
 * failures stay out of the session.
 */
export type Failure = { ok: false; status: number; code: string; message: string }
export type UploadResult = { ok: true; lastSeq: number; duplicate: boolean } | Failure
/** `session` is the control plane's id for it (absent until its first chunk lands). */
export type StatusResult = { ok: true; lastSeq: number; deleted?: boolean; session?: string } | Failure
/** XCOD-284: whether a synced copy existed and was deleted (false: there was none to delete). */
export type RemoveResult = { ok: true; deleted: boolean } | Failure

export const file = () => path.join(Global.Path.data, "cloud", "sync", "device.json")

export const NOTICE = `Sessions sync to your Lunos space (EU). Run "lunos sync off" to stop on this device.`
export const POLICY_OFF = "Your organisation's policy keeps session sync off."
export const NEEDS_ENDPOINT = "Session sync needs cloud.endpoint for your organisation's identity provider."
export const NOT_REGISTERED = "This device isn't registered for session sync. Run lunos sync on (or lunos login)."

/** No device.json: only `lunos login` and `lunos sync on` register one. */
export class NotRegisteredError extends Error {
  constructor() {
    super(NOT_REGISTERED)
  }
}

/** The signed-in issuer is an organisation's, and no endpoint was configured for it. */
export class NotPermittedError extends Error {
  constructor() {
    super(NEEDS_ENDPOINT)
  }
}

/** `cloud.endpoint` as managed, then global config set it; undefined when neither does. */
export async function configured() {
  const managed = await SandboxConfig.managedDoc()
  return (
    (ConfigPolicy.get(managed, "cloud.endpoint") as string | undefined) ??
    (ConfigPolicy.get(SandboxConfig.globalDoc(), "cloud.endpoint") as string | undefined)
  )
}

const trimmed = (url: string) => url.replace(/\/+$/, "")

/**
 * Whether sync may send this sign-in's token anywhere: only a Lunos sign-in goes to Lunos Cloud by
 * default. An organisation's identity provider issues tokens meant for the organisation, so they go
 * only to a control plane someone configured explicitly (global or managed `cloud.endpoint`).
 */
export async function permitted(issuer: string) {
  if (trimmed(issuer) === trimmed(CloudDefaults.DEFAULT_ISSUER)) return true
  return (await configured()) !== undefined
}

export async function endpoint() {
  const raw = (await configured()) ?? CloudDefaults.DEFAULT_ENDPOINT
  const url = new URL(raw)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error(`cloud.endpoint must be https: ${raw}`)
  return url.toString().replace(/\/$/, "")
}

async function who(opts: Options) {
  if (opts.token && opts.sub) return { token: await opts.token(), sub: opts.sub }
  // Checked on the stored session before any refresh: nothing is sent for a sign-in sync may not use.
  const stored = await CloudStore.load()
  if (stored && !(await permitted(stored.issuer))) throw new NotPermittedError()
  const s = await CloudAuth.session("Session sync")
  return { token: opts.token ? await opts.token() : s.tokens.access_token, sub: opts.sub ?? s.sub }
}

async function request(
  base: string,
  token: string,
  method: string,
  p: string,
  body: string | undefined,
  opts: Options,
) {
  return (opts.fetch ?? fetch)(base + p, {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  })
}

async function failure(res: Response): Promise<Failure> {
  const json = (await res.json().catch(() => undefined)) as any
  return {
    ok: false,
    status: res.status,
    code: json?.error?.code ?? `http_${res.status}`,
    message: json?.error?.message ?? `HTTP ${res.status}`,
  }
}

/** Runs one call; anything it throws becomes a `Failure` instead. */
async function settle<T>(fn: () => Promise<T | Failure>): Promise<T | Failure> {
  try {
    return await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof CloudAuth.SignedOutError) return { ok: false, status: 0, code: "signed_out", message }
    if (error instanceof NotPermittedError) return { ok: false, status: 0, code: "not_permitted", message }
    return { ok: false, status: 0, code: "network", message }
  }
}

export async function load(): Promise<State | undefined> {
  return fs
    .readFile(file(), "utf8")
    .then((t) => JSON.parse(t) as State)
    .catch(() => undefined)
}

export async function save(state: State) {
  const dir = path.dirname(file())
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies to a directory it creates, and writeFile's is masked by the umask.
  await fs.chmod(dir, 0o700)
  const tmp = `${file()}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  await fs.chmod(tmp, 0o600)
  await fs.rename(tmp, file())
}

export async function register(opts: Options = {}): Promise<State> {
  const base = opts.endpoint ?? (await endpoint())
  const { token, sub } = await who(opts)
  const stored = await load()
  if (stored && stored.endpoint === base && stored.sub === sub) {
    const res = await request(base, token, "GET", "/v1/devices", undefined, opts)
    if (res.ok) {
      const current = ((await res.json()) as { devices: Device[] }).devices.find((d) => d.id === stored.device.id)
      if (current && !current.revokedAt) {
        const next = { ...stored, device: current }
        await save(next)
        return next
      }
    } else if (res.status !== 401 && res.status !== 403) return stored
  }
  const res = await request(
    base,
    token,
    "POST",
    "/v1/devices",
    JSON.stringify({ name: os.hostname(), platform: process.platform }),
    opts,
  )
  if (!res.ok) throw new Error(`Couldn't register this device with ${base}: ${(await failure(res)).message}`)
  // On purpose, a replacement device for the same user keeps `noticeShown`: they have seen the notice.
  const state: State = {
    endpoint: base,
    sub,
    device: (await res.json()) as Device,
    noticeShown: stored?.sub === sub ? stored.noticeShown : false,
  }
  await save(state)
  return state
}

/** Flips this device's switch on the control plane. Never registers: throws NotRegisteredError without device.json. */
export async function setEnabled(on: boolean, opts: Options = {}) {
  const state = await load()
  if (!state) throw new NotRegisteredError()
  const { token } = await who(opts)
  const res = await request(
    state.endpoint,
    token,
    "PATCH",
    `/v1/devices/${encodeURIComponent(state.device.id)}`,
    JSON.stringify({ syncEnabled: on }),
    opts,
  )
  if (!res.ok) throw new Error((await failure(res)).message)
  const next: State = { ...state, device: (await res.json()) as Device, paused: on ? undefined : state.paused }
  await save(next)
  return next
}

/**
 * After `lunos login` or `lunos sync on` registered the device: the first-sync notice, once per
 * device, when the device syncs; or the policy line when an organisation locks sync off.
 */
export async function notice(state: State, lockedOff: boolean, print: (line: string) => void) {
  if (lockedOff) return print(POLICY_OFF)
  if (state.noticeShown || !state.device.syncEnabled) return
  print(NOTICE)
  await save({ ...state, noticeShown: true }).catch(() => undefined)
}

export async function upload(
  state: State,
  session: string,
  seq: number,
  body: string,
  opts: Options = {},
): Promise<UploadResult> {
  return settle(async () => {
    const { token } = await who(opts)
    const p = `/v1/sync/devices/${encodeURIComponent(state.device.id)}/sessions/${encodeURIComponent(session)}/chunks/${seq}`
    const res = await request(state.endpoint, token, "PUT", p, body, opts)
    if (!res.ok) return failure(res)
    const json = (await res.json()) as { lastSeq: number; duplicate: boolean }
    return { ok: true as const, lastSeq: json.lastSeq, duplicate: json.duplicate }
  })
}

export async function status(state: State, session: string, opts: Options = {}): Promise<StatusResult> {
  return settle(async () => {
    const { token } = await who(opts)
    const p = `/v1/sync/devices/${encodeURIComponent(state.device.id)}/sessions/${encodeURIComponent(session)}`
    const res = await request(state.endpoint, token, "GET", p, undefined, opts)
    if (!res.ok) return failure(res)
    const json = (await res.json()) as { lastSeq: number; deleted?: boolean; session?: string }
    return {
      ok: true as const,
      lastSeq: json.lastSeq,
      ...(json.deleted ? { deleted: true } : {}),
      ...(json.session ? { session: json.session } : {}),
    }
  })
}

/**
 * XCOD-284: deletes the synced copy of a Lunos session from the user's space (`DELETE
 * /v1/sessions/{id}`; the control plane purges it 30 days later). Looked up by this device and the
 * Lunos session id first. Nothing is sent when this device has no sync, or sync is off on it: then
 * nothing of the session was uploaded from here since, and `ok` with `deleted: false` is returned.
 */
export async function removeSession(session: string, opts: Options & { state?: State } = {}): Promise<RemoveResult> {
  const state = opts.state ?? (await load())
  if (!state || !state.device.syncEnabled) return { ok: true, deleted: false }
  // Once there is no synced copy, nothing still queued for the session is uploaded. Only then: a
  // failed call leaves the session (and its sync) as it was, to try again.
  const forget = () => CloudSyncQueue.drop(session, "deleted").catch(() => undefined)
  const found = await status(state, session, opts)
  if (!found.ok) return found
  if (!found.session || found.deleted) {
    await forget()
    return { ok: true, deleted: false }
  }
  const result = await settle(async () => {
    const { token } = await who(opts)
    const res = await request(
      state.endpoint,
      token,
      "DELETE",
      `/v1/sessions/${encodeURIComponent(found.session!)}`,
      undefined,
      opts,
    )
    // Gone already (deleted on app.lunos.tech meanwhile): nothing left to delete.
    if (res.status === 404 || res.status === 410) return { ok: true as const, deleted: false }
    if (!res.ok) return failure(res)
    return { ok: true as const, deleted: true }
  })
  if (result.ok) await forget()
  return result
}
