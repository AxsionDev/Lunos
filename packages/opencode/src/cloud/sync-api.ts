export * as CloudSyncApi from "./sync-api"


import { randomUUID } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { CloudAuth } from "./auth"
import { CloudDefaults } from "./defaults"
import { ConfigPolicy } from "@/config/policy"
import { SandboxConfig } from "@/sandbox/config"

/**
 * Session sync's client for the control plane (lunos-web spec 2026-10-13 §3-4, C1, C4). The
 * endpoint comes from managed, then global config, never a project's: sync runs on its own with the
 * user's token, so a repository must not choose where it goes. The device's sync switch lives on
 * the server (C4); `device.json` caches it for offline starts.
 */
export type Device = { id: string; name: string; platform: string; syncEnabled: boolean; lastSyncAt?: number; createdAt: number; revokedAt?: number }
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
export type StatusResult = { ok: true; lastSeq: number; deleted?: boolean } | Failure

export const file = () => path.join(Global.Path.data, "cloud", "sync", "device.json")

export async function endpoint() {
  const managed = await SandboxConfig.managedDoc()
  const raw =
    (ConfigPolicy.get(managed, "cloud.endpoint") as string | undefined) ??
    (ConfigPolicy.get(SandboxConfig.globalDoc(), "cloud.endpoint") as string | undefined) ??
    CloudDefaults.DEFAULT_ENDPOINT
  const url = new URL(raw)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error(`cloud.endpoint must be https: ${raw}`)
  return url.toString().replace(/\/$/, "")
}

async function who(opts: Options) {
  if (opts.token && opts.sub) return { token: await opts.token(), sub: opts.sub }
  const s = await CloudAuth.session("Session sync")
  return { token: opts.token ? await opts.token() : s.tokens.access_token, sub: opts.sub ?? s.sub }
}

async function request(base: string, token: string, method: string, p: string, body: string | undefined, opts: Options) {
  return (opts.fetch ?? fetch)(base + p, {
    method,
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  })
}

async function failure(res: Response): Promise<Failure> {
  const json = (await res.json().catch(() => undefined)) as any
  return { ok: false, status: res.status, code: json?.error?.code ?? `http_${res.status}`, message: json?.error?.message ?? `HTTP ${res.status}` }
}

/** Runs one call; anything it throws becomes a `Failure` instead. */
async function settle<T>(fn: () => Promise<T | Failure>): Promise<T | Failure> {
  try {
    return await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof CloudAuth.SignedOutError) return { ok: false, status: 0, code: "signed_out", message }
    return { ok: false, status: 0, code: "network", message }
  }
}

export async function load(): Promise<State | undefined> {
  return fs.readFile(file(), "utf8").then((t) => JSON.parse(t) as State).catch(() => undefined)
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
  const res = await request(base, token, "POST", "/v1/devices", JSON.stringify({ name: os.hostname(), platform: process.platform }), opts)
  if (!res.ok) throw new Error(`Couldn't register this device with ${base}: ${(await failure(res)).message}`)
  // On purpose, a replacement device for the same user keeps `noticeShown`: they have seen the notice.
  const state: State = { endpoint: base, sub, device: (await res.json()) as Device, noticeShown: stored?.sub === sub ? stored.noticeShown : false }
  await save(state)
  return state
}

export async function setEnabled(on: boolean, opts: Options = {}) {
  const state = await register(opts)
  const { token } = await who(opts)
  const res = await request(state.endpoint, token, "PATCH", `/v1/devices/${encodeURIComponent(state.device.id)}`, JSON.stringify({ syncEnabled: on }), opts)
  if (!res.ok) throw new Error((await failure(res)).message)
  const next: State = { ...state, device: (await res.json()) as Device, paused: on ? undefined : state.paused }
  await save(next)
  return next
}

export async function upload(state: State, session: string, seq: number, body: string, opts: Options = {}): Promise<UploadResult> {
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
    const json = (await res.json()) as { lastSeq: number; deleted?: boolean }
    return { ok: true as const, lastSeq: json.lastSeq, ...(json.deleted ? { deleted: true } : {}) }
  })
}
