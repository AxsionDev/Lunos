export * as ConfigOrgPolicy from "./org-policy"

import { createHash } from "crypto"
import { existsSync, readFileSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Offline } from "@opencode-ai/core/offline"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { AuditLog } from "@/audit/log"
import { CloudAuth } from "@/cloud/auth"
import { CloudHosted } from "@/cloud/hosted"
import { CloudStore } from "@/cloud/store"
import { ConfigParse } from "./parse"
import { ConfigPolicy } from "./policy"
import { ConfigV2Compat } from "./v2-compat"

// XCOD-238: the organisation policy served by the Lunos console (`GET /v1/orgs/{org}/policy`, the
// XCOD-102 managed-config format with `$locked` keys), fetched at start and enforced exactly like
// managed config on disk.
//
// - The URL is `cloud.policy`, read from on-disk managed config only: a repository can't send the
//   user's sign-in to its own host, and the user can't point Lunos at a looser policy.
// - It is fetched only while signed in (`lunos login`), with the session's access token, as a
//   conditional request (the console's ETag is the policy's SHA-256), within TIMEOUT_MS.
// - Only a 200 whose policy hashes to the SHA-256 the console sent, and that this version's schema
//   accepts, replaces the cache. Anything else (offline, signed out, 401, 404, 5xx, a timeout)
//   keeps using the last cached copy, so signing out or blocking the console doesn't drop it.
// - XCOD-241: with LUNOS_OFFLINE nothing is fetched (no token refresh either): the cached copy
//   applies. Whenever the console's copy isn't confirmed at start, `notice()` says which copy
//   applies and when it was fetched (a TUI toast, a `lunos run` stderr line).
// - The cache sits under the user's data directory, so the user can edit it. A cached copy whose
//   policy doesn't hash to its recorded SHA-256 is ignored, and the conditional request carries the
//   cached SHA-256: an edited copy never matches the console's, so while the console is reachable
//   and the user is signed in, the console's copy replaces it. Offline or signed out, a consistently
//   re-hashed copy would be used; `client.start` records its SHA-256 so the audit trail shows it.
// - Merging with on-disk managed config: `$locked` lists are unioned; a key on-disk managed config
//   sets wins whole (no array concatenation), so the fetched copy only fills keys it leaves unset.

export const TIMEOUT_MS = 3000

export const cacheFile = () => path.join(Global.Path.data, "cloud", "policy.json")

type Doc = Record<string, unknown>
const isDoc = (value: unknown): value is Doc => !!value && typeof value === "object" && !Array.isArray(value)

/** The console's hash: SHA-256 of the policy as it stores and serves it (2-space JSON, newline). */
export function sha256(policy: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(policy, null, 2) + "\n", "utf8")
    .digest("hex")
}

/** `cloud.policy` from on-disk managed config (the last document that sets it), if usable. */
export function policyURL(onDisk: readonly unknown[]): string | undefined {
  const url = onDisk
    .map((doc) => ConfigPolicy.get(doc, "cloud.policy"))
    .findLast((value): value is string => typeof value === "string" && value.length > 0)
  if (!url) return
  // As for lunos login: the access token must never travel in the clear, except to this machine.
  if (/^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)) return url
}

/** XCOD-242: whether on-disk managed config turns hosted team features off (`cloud.auto_team: false`). */
export function autoTeamOff(onDisk: readonly unknown[]) {
  return onDisk.some((doc) => ConfigPolicy.get(doc, "cloud.auto_team") === false)
}

/** Where team features come from: managed config's `cloud.policy`, or a Lunos sign-in (XCOD-242). */
export type TeamSource = { url: string; via: "managed" | "hosted" }

/**
 * The organisation policy URL in effect, and why. Managed `cloud.policy` always wins; without it, the
 * hosted organisation remembered at `lunos login`, unless managed config sets `cloud.auto_team: false`.
 * No network: every team feature (the policy, marketplace, memory, sharing) finds its console here.
 */
export function teamSource(onDisk: readonly unknown[]): TeamSource | undefined {
  const managed = policyURL(onDisk)
  if (managed) return { url: managed, via: "managed" }
  if (autoTeamOff(onDisk)) return
  const hosted = CloudHosted.policyURL()
  if (hosted) return { url: hosted, via: "hosted" }
}

/**
 * XCOD-242: a hosted organisation's policy may not set or lock `cloud` (issuer, endpoint, policy).
 * Its members' Lunos sign-in is valid for their whole Lunos account, so an organisation admin must
 * not be able to point sync, cloud runs or the next sign-in at another host. Managed config, which
 * the organisation pushes to machines it owns, keeps that power.
 */
export function withoutCloud(layer: Doc | undefined): Doc | undefined {
  if (!layer) return layer
  const { cloud: _cloud, ...rest } = layer
  const locked = ConfigPolicy.lockList(rest).filter((key) => key !== "cloud" && !key.startsWith("cloud."))
  if (ConfigPolicy.FIELD in rest) rest[ConfigPolicy.FIELD] = locked
  return rest
}

/** The result, with a hosted organisation's policy kept out of `cloud` (withoutCloud). */
function scoped(result: Result, source: TeamSource | undefined): Result {
  if (source?.via !== "hosted" || !result.layer) return result
  return { ...result, layer: withoutCloud(result.layer) }
}

export type Cache = {
  url: string
  etag: string
  sha256: string
  version?: number
  org?: string
  fetchedAt: string
  policy: Doc
}

/** The cached copy for `url`, only if it is intact: its policy hashes to its recorded SHA-256. */
export function readCache(url: string): Cache | undefined {
  const file = cacheFile()
  if (!existsSync(file)) return
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as Cache
    if (cache.url !== url || !isDoc(cache.policy) || typeof cache.sha256 !== "string") return
    if (sha256(cache.policy) !== cache.sha256 || cache.etag !== `"${cache.sha256}"`) return
    return cache
  } catch {
    return
  }
}

async function writeCache(cache: Cache) {
  const file = cacheFile()
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Written whole and renamed into place: a TUI and a `lunos run` may start at the same moment.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

/** Whether this version can load the policy. A newer console may accept keys this client rejects. */
function loadable(policy: Doc) {
  try {
    ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(ConfigPolicy.strip(policy)).value, "organisation policy")
    return true
  } catch {
    return false
  }
}

/**
 * The fetched policy without the keys on-disk managed config sets: on a conflict, the on-disk value
 * wins whole (an on-disk `residency.allow: ["eu"]` is never widened by a fetched `["us"]`). Objects
 * both set are compared key by key. `$locked` is kept: lock lists are unioned.
 */
export function subtract(fetched: Doc, onDisk: readonly unknown[]): Doc {
  const walk = (doc: Doc, others: Doc[], top: boolean): Doc => {
    const next: Doc = {}
    for (const [key, value] of Object.entries(doc)) {
      if (top && key === ConfigPolicy.FIELD) {
        next[key] = value
        continue
      }
      const set = others.filter((other) => other[key] !== undefined)
      if (!set.length) {
        next[key] = value
        continue
      }
      if (isDoc(value) && set.every((other) => isDoc(other[key])))
        next[key] = walk(
          value,
          set.map((other) => other[key] as Doc),
          false,
        )
    }
    return next
  }
  return walk(fetched, onDisk.filter(isDoc), true)
}

export type Fetch =
  | "ok"
  | "not_modified"
  | "signed_out"
  | "unauthorized"
  | "not_found"
  | "failed"
  | "unreachable"
  | "invalid"
  /** XCOD-241: LUNOS_OFFLINE is set; nothing was fetched. */
  | "offline"

export type Result = {
  url?: string
  /** "console": fetched (or confirmed unchanged) now; "cache": the last copy; "none": neither. */
  source: "console" | "cache" | "none"
  fetch?: Fetch
  /** The policy as the console serves it, and as a managed layer (on-disk keys removed). */
  policy?: Doc
  layer?: Doc
  sha256?: string
  version?: number
  /** When the copy in use was fetched (ISO 8601). */
  fetchedAt?: string
}

function fromCache(url: string, cache: Cache | undefined, onDisk: readonly unknown[], fetch: Fetch): Result {
  if (!cache) return { url, source: "none", fetch }
  return {
    url,
    source: "cache",
    fetch,
    policy: cache.policy,
    layer: subtract(cache.policy, onDisk),
    sha256: cache.sha256,
    version: cache.version,
    fetchedAt: cache.fetchedAt,
  }
}

/** The session's access token, refreshed (with discovery) only when it is about to expire. */
export async function accessToken() {
  const stored = await CloudStore.load()
  if (!stored) return
  const expires = stored.tokens.expires_at
  if (expires === undefined || expires * 1000 > Date.now() + 30_000) return stored.tokens.access_token
  return CloudAuth.session("The organisation policy")
    .then((session) => session.tokens.access_token)
    .catch(() => undefined)
}

export type Options = { fetch?: typeof fetch; timeoutMs?: number; token?: () => Promise<string | undefined> }

/** Fetches the policy (or confirms the cache) and falls back to the cache on any failure. */
export async function fetchPolicy(url: string, onDisk: readonly unknown[], opts: Options = {}): Promise<Result> {
  const cache = readCache(url)
  const timeout = opts.timeoutMs ?? TIMEOUT_MS
  const deadline = Date.now() + timeout
  const token = await Promise.race([
    (opts.token ?? accessToken)().catch(() => undefined),
    Bun.sleep(timeout).then(() => undefined),
  ])
  if (!token) return fromCache(url, cache, onDisk, "signed_out")
  let response: Response
  try {
    response = await (opts.fetch ?? fetch)(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(cache ? { "if-none-match": cache.etag } : {}),
      },
      // A redirect must not carry the token somewhere else.
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
  } catch {
    return fromCache(url, cache, onDisk, "unreachable")
  }
  if (response.status === 304 && cache) return { ...fromCache(url, cache, onDisk, "not_modified"), source: "console" }
  if (response.status === 401 || response.status === 403) return fromCache(url, cache, onDisk, "unauthorized")
  if (response.status === 404) return fromCache(url, cache, onDisk, "not_found")
  if (response.status !== 200) return fromCache(url, cache, onDisk, "failed")
  const body = (await response.json().catch(() => undefined)) as
    | { policy?: unknown; sha256?: unknown; version?: unknown; org?: unknown }
    | undefined
  const policy = body?.policy
  const etag = response.headers.get("etag")
  if (
    !isDoc(policy) ||
    typeof body?.sha256 !== "string" ||
    sha256(policy) !== body.sha256 ||
    (etag !== null && etag !== `"${body.sha256}"`) ||
    !loadable(policy)
  )
    return fromCache(url, cache, onDisk, "invalid")
  const next: Cache = {
    url,
    etag: `"${body.sha256}"`,
    sha256: body.sha256,
    version: typeof body.version === "number" ? body.version : undefined,
    org: typeof body.org === "string" ? body.org : undefined,
    fetchedAt: new Date().toISOString(),
    policy,
  }
  await writeCache(next).catch(() => undefined)
  return {
    url,
    source: "console",
    fetch: "ok",
    policy,
    layer: subtract(policy, onDisk),
    sha256: next.sha256,
    version: next.version,
    fetchedAt: next.fetchedAt,
  }
}

/** The cached copy only, without any network: for decisions made before async work can run. */
export function resolveSync(onDisk: readonly unknown[]): Result {
  const source = teamSource(onDisk)
  if (!source) return { source: "none" }
  return scoped(fromCache(source.url, readCache(source.url), onDisk, "unreachable"), source)
}

let current: Promise<Result> | undefined
let announce = true
let started: { result: Result; fields: ReturnType<typeof startFields> } | undefined

/** `lunos audit` reads, verifies and exports the trail; it doesn't add its own start to it. */
export function quietStart() {
  announce = false
}

/** Whether this process announces its start (`client.start`); `lunos audit` doesn't. */
export function announces() {
  return announce
}

/**
 * XCOD-241: which Lunos surface this process is. The CLI sets `LUNOS_SURFACE` from its command
 * before anything loads config, so the TUI's worker (which copies the environment) sees it too.
 */
export const SURFACES = ["tui", "desktop", "ide", "run", "serve", "other"] as const
export type Surface = (typeof SURFACES)[number]

export function surfaceFor(command: string, env: NodeJS.ProcessEnv = process.env): Surface {
  if (command === "acp") return "ide"
  if (command === "run") return "run"
  // The desktop app's WSL sidecar runs `lunos serve` with OPENCODE_CLIENT=desktop.
  if (command === "serve" || command === "web") return env["OPENCODE_CLIENT"] === "desktop" ? "desktop" : "serve"
  // The VS Code extension starts the TUI in its terminal with OPENCODE_CALLER=vscode.
  if (command === "" || command === "attach") return env["OPENCODE_CALLER"]?.startsWith("vscode") ? "ide" : "tui"
  return "other"
}

/** Set by the CLI; the desktop app's own sidecar loads the server without it, as OPENCODE_CLIENT=desktop. */
export function surface(): Surface {
  const value = process.env["LUNOS_SURFACE"]
  if ((SURFACES as readonly string[]).includes(value ?? "")) return value as Surface
  return process.env["OPENCODE_CLIENT"] === "desktop" ? "desktop" : "other"
}

/**
 * The policy for this process, fetched once, at the first config load. Also writes `client.start`
 * to the audit trail (held until the trail is activated with the resolved config). Offline
 * (XCOD-241), only the cached copy: no request, not even a token refresh.
 */
export function resolve(onDisk: readonly unknown[], opts: Options = {}): Promise<Result> {
  current ??= (async () => {
    const source = teamSource(onDisk)
    const url = source?.url
    const result: Result = scoped(
      !url
        ? { source: "none" }
        : Offline.enabled()
          ? fromCache(url, readCache(url), onDisk, "offline")
          : await fetchPolicy(url, onDisk, opts).catch(() => fromCache(url, readCache(url), onDisk, "failed")),
      source,
    )
    const fields = startFields(result, onDisk)
    started = { result, fields }
    if (announce) AuditLog.emit("client.start", fields)
    // `lunos run` says it on stderr; the TUI shows it as a toast once it is listening.
    const text = notice(result)
    if (text && announce && surface() === "run") process.stderr.write(`! ${text}\n`)
    return result
  })()
  return current
}

/** This process's policy result and its `client.start` fields, once resolved. */
export function startInfo() {
  return started
}

const REASONS: Partial<Record<Fetch, string>> = {
  unauthorized: "the console refused your sign-in",
  not_found: "the console has no policy at that address",
  failed: "the console answered with an error",
  unreachable: "the console couldn't be reached",
  invalid: "the console sent a policy this version can't use",
}

/** `2026-10-13 06:34 UTC`: the same for everyone, whatever the machine's time zone. */
function when(iso: string | undefined) {
  const date = iso ? new Date(iso) : undefined
  if (!date || Number.isNaN(date.getTime())) return "an unknown time"
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC"
}

/**
 * XCOD-241: what to tell the developer when the console's copy of the policy wasn't confirmed at
 * this start: which copy applies, and when it was fetched. Undefined when it was confirmed, or
 * when no `cloud.policy` is configured.
 */
export function notice(result: Result | undefined = started?.result): string | undefined {
  if (!result?.url || result.source === "console") return
  const host = (() => {
    try {
      return new URL(result.url!).host
    } catch {
      return result.url!
    }
  })()
  const why =
    result.fetch === "offline"
      ? "Offline mode (LUNOS_OFFLINE)"
      : result.fetch === "signed_out"
        ? "You're not signed in (lunos login)"
        : `Couldn't fetch your organisation's policy from ${host}: ${REASONS[result.fetch ?? "failed"] ?? REASONS.failed}`
  if (result.source === "cache")
    return `${why}. Using your organisation's policy as last fetched from ${host} at ${when(result.fetchedAt)}.`
  return `${why}. No copy of your organisation's policy from ${host} has been fetched yet, so none applies: only managed config on this machine.`
}

/** Tests only: forget the fetched policy, so the next config load fetches again. */
export function reset() {
  current = undefined
  started = undefined
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isDoc(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}

function merge(target: Doc, source: Doc): Doc {
  const next: Doc = { ...target }
  for (const [key, value] of Object.entries(source))
    next[key] = isDoc(value) && isDoc(next[key]) ? merge(next[key] as Doc, value) : value
  return next
}

/**
 * The digest of the policy in effect: the fetched layer, then the on-disk documents in precedence
 * order, merged (later values win, `$locked` lists unioned and sorted), as JSON with sorted keys,
 * SHA-256. Undefined when there is no policy at all.
 */
export function digest(docs: readonly unknown[]): string | undefined {
  const present = docs.filter(isDoc)
  if (!present.length) return
  const merged = present.reduce<Doc>((acc, doc) => merge(acc, doc), {})
  const locked = ConfigPolicy.union(...present.map(ConfigPolicy.lockList)).sort()
  if (locked.length) merged[ConfigPolicy.FIELD] = locked
  else delete merged[ConfigPolicy.FIELD]
  return createHash("sha256")
    .update(JSON.stringify(canonical(merged)), "utf8")
    .digest("hex")
}

export function startFields(result: Result, onDisk: readonly unknown[]) {
  const disk = onDisk.filter(isDoc)
  const sources = [...(disk.length ? ["managed"] : []), ...(result.source !== "none" ? [result.source] : [])]
  return {
    version: InstallationVersion,
    os: process.platform,
    arch: process.arch,
    policy_digest: digest([result.layer, ...disk]),
    policy_source: sources.length ? sources.join("+") : "none",
    ...(result.url ? { policy_fetch: result.fetch } : {}),
    ...(result.sha256 ? { policy_sha256: result.sha256 } : {}),
    ...(result.version !== undefined ? { policy_version: result.version } : {}),
  }
}
