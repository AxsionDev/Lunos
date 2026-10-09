export * as CloudWorkers from "./workers"

import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { Audit } from "@opencode-ai/core/audit"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Offline } from "@opencode-ai/core/offline"
import { AuditLog } from "@/audit/log"
import { CloudAuth } from "./auth"
import { CloudContract } from "./contract"

/**
 * XCOD-186: the client side of Lunos Cloud workers. `lunos run --cloud` and the `lunos-cloud`
 * workspace adapter both use it, the way `lunos run --sandbox` and the docker adapter share Sandbox.
 *
 * Nothing leaves the machine until every local check passes: not offline, signed in, the control
 * plane's region allowed by the residency policy, and the starting commit already on the remote
 * (the worker clones it; Lunos never uploads your working tree). Each refusal is audited as
 * `cloud.denied`, each dispatch as `cloud.dispatch`, each end as `cloud.finish`.
 */

export class RefusedError extends Error {
  override name = "CloudRefused"
}

export class ServiceError extends Error {
  override name = "CloudServiceError"
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Config = Parameters<typeof AuditLog.residency>[0] & {
  cloud?: { endpoint?: string }
}

export const NO_ENDPOINT =
  "Lunos Cloud workers aren't available yet. To use a control plane you run, set cloud.endpoint (lunos settings set cloud.endpoint https://…)."

function auditFile(config: Config) {
  const residency = AuditLog.residency(config)
  if (residency?.audit) return residency.auditPath ?? AuditLog.DEFAULT_FILE()
  const settings = AuditLog.resolve(config)
  return settings.enabled ? settings.file : undefined
}

export function record(
  config: Config,
  event: "cloud.dispatch" | "cloud.finish" | "cloud.denied",
  fields: Audit.Fields,
) {
  const file = auditFile(config)
  if (file) void Audit.write({ file }, event, fields)
}

/** The control plane's URL, checked: https, or localhost for testing (as `cloud.issuer`). */
export function endpoint(config: Config) {
  const raw = config.cloud?.endpoint
  if (!raw) throw new RefusedError(NO_ENDPOINT)
  const url = new URL(raw)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new RefusedError(`cloud.endpoint must be https (localhost excepted): ${raw}`)
  return url.toString().replace(/\/$/, "")
}

export function newID() {
  return randomBytes(6).toString("hex")
}

async function call<A>(
  base: string,
  token: string,
  method: string,
  path: string,
  schema: Schema.Decoder<A>,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<A> {
  const response = await fetcher(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).catch((error: unknown) => {
    throw new ServiceError(0, "unreachable", `Can't reach Lunos Cloud at ${base}: ${String(error)}`)
  })
  const json = await response.json().catch(() => undefined)
  if (!response.ok) {
    const parsed = Schema.decodeUnknownOption(CloudContract.ErrorBody)(json)
    const code =
      parsed._tag === "Some"
        ? parsed.value.error.code
        : (CloudContract.ERRORS[response.status as keyof typeof CloudContract.ERRORS] ?? "error")
    const detail = parsed._tag === "Some" ? parsed.value.error.message : `HTTP ${response.status}`
    throw new ServiceError(response.status, code, explain(response.status, detail))
  }
  return Schema.decodeUnknownSync(schema)(json)
}

/** The service's own message, with what to do about the cases a user can act on. */
export function explain(status: number, message: string) {
  if (status === 401) return `${message} Run lunos login.`
  if (status === 402) return `${message} (spending cap reached; nothing was billed past it)`
  if (status === 429) return `${message} (too many cloud runs at once for your plan; wait for one to finish)`
  return message
}

export interface Dispatch {
  config: Config
  repo: CloudContract.CreateWorker["repo"]
  size?: "standard" | "large"
  /** Secrets the user named for this run. Nothing else is sent. */
  secrets?: Record<string, string>
  fetcher?: typeof fetch
}

export interface Started {
  base: string
  token: string
  worker: CloudContract.Worker
}

/** Checks, then asks the control plane for a worker and waits until it's running. */
export async function create(input: Dispatch, id = newID()): Promise<Started> {
  const { config } = input
  const refuse = (reason: string, why: string): never => {
    record(config, "cloud.denied", { reason })
    throw new RefusedError(why)
  }
  if (Offline.enabled()) refuse("offline", Offline.message("Dispatching a run to Lunos Cloud"))
  const base = endpoint(config)
  const session = await CloudAuth.session("A cloud run").catch((error) => {
    if (error instanceof CloudAuth.SignedOutError) refuse("signed-out", error.message)
    throw error
  })
  const token = session.tokens.access_token
  const service = await call(base, token, "GET", "/v1", CloudContract.Service, undefined, input.fetcher)
  if (service.api !== CloudContract.VERSION)
    throw new RefusedError(
      `Lunos Cloud at ${base} speaks API ${service.api}; this Lunos speaks ${CloudContract.VERSION}. Update Lunos.`,
    )
  const resolved = AuditLog.residency(config)
  if (resolved && resolved.enforce !== false && !resolved.policy.allow.includes(service.region))
    refuse(
      "residency",
      `Lunos Cloud at ${base} runs workers in "${service.region}", and the data-residency policy allows only: ${resolved.policy.allow.join(", ")}. The run wasn't sent.`,
    )
  const body: CloudContract.CreateWorker = {
    repo: input.repo,
    size: input.size ?? "standard",
    residency: resolved && resolved.enforce !== false ? { allow: [...resolved.policy.allow], enforce: true } : null,
    secrets: input.secrets ?? {},
    client: { version: InstallationVersion },
  }
  record(config, "cloud.dispatch", {
    worker: id,
    endpoint: base,
    region: service.region,
    repo: input.repo.url,
    commit: input.repo.commit,
    size: body.size,
    secrets: Object.keys(body.secrets).join(",") || undefined,
  })
  let worker = await call(base, token, "PUT", `/v1/workers/${id}`, CloudContract.Worker, body, input.fetcher)
  const deadline = Date.now() + 5 * 60_000
  while (worker.status === "starting") {
    if (Date.now() > deadline) throw new ServiceError(0, "timeout", `Worker ${id} didn't start within 5 minutes`)
    await Bun.sleep(1000)
    worker = await call(base, token, "GET", `/v1/workers/${id}`, CloudContract.Worker, undefined, input.fetcher)
  }
  if (worker.status !== "running" || !worker.url)
    throw new ServiceError(0, "failed", `Worker ${id} didn't start (status ${worker.status})`)
  if (worker.branch !== CloudContract.branch(id))
    throw new ServiceError(
      0,
      "contract",
      `Worker ${id} would push to "${worker.branch}", not ${CloudContract.branch(id)}`,
    )
  return { base, token, worker }
}

export async function get(base: string, id: string, fetcher?: typeof fetch) {
  const session = await CloudAuth.session("A cloud run")
  return call(base, session.tokens.access_token, "GET", `/v1/workers/${id}`, CloudContract.Worker, undefined, fetcher)
}

/** Ends the worker; the control plane pushes the results branch before it answers. */
export async function finish(config: Config, base: string, id: string, outcome: string, fetcher?: typeof fetch) {
  const session = await CloudAuth.session("A cloud run")
  const done = await call(
    base,
    session.tokens.access_token,
    "DELETE",
    `/v1/workers/${id}`,
    CloudContract.Finished,
    undefined,
    fetcher,
  )
  record(config, "cloud.finish", {
    worker: id,
    outcome,
    branch: done.pushed ? done.branch : undefined,
    commit: done.commit,
    active_seconds: done.activeSeconds,
  })
  return done
}

/** The worker's server, as a workspace target or for `lunos run --attach`. */
export function connection(worker: CloudContract.Worker) {
  if (!worker.url || !worker.auth) throw new ServiceError(0, "contract", `Worker ${worker.id} has no server address`)
  return {
    url: worker.url,
    username: worker.auth.username,
    password: worker.auth.password,
    directory: worker.directory,
    headers: {
      Authorization: `Basic ${Buffer.from(`${worker.auth.username}:${worker.auth.password}`).toString("base64")}`,
    },
  }
}

async function git(directory: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { ok: code === 0, out: stdout.trim() }
}

/**
 * What the worker clones: the remote of the current branch (else `origin`) at HEAD. HEAD must
 * already be on that remote, because Lunos never uploads the working tree. `uncommitted` lists
 * changes that won't be in the run.
 */
export async function repo(directory: string, config: Config) {
  const refuse = (reason: string, why: string): never => {
    record(config, "cloud.denied", { reason })
    throw new RefusedError(why)
  }
  const top = await git(directory, "rev-parse", "--show-toplevel")
  if (!top.ok) refuse("not-git", `A cloud run starts from a git repository; ${directory} isn't one.`)
  const branch = (await git(directory, "symbolic-ref", "--quiet", "--short", "HEAD")).out || undefined
  const upstream = branch ? (await git(directory, "config", `branch.${branch}.remote`)).out : ""
  const remote = upstream || "origin"
  const url = await git(directory, "remote", "get-url", remote)
  if (!url.ok)
    refuse("no-remote", `A cloud run clones your repository from its remote, and this one has no "${remote}".`)
  const commit = (await git(directory, "rev-parse", "HEAD")).out
  const pushed = await git(directory, "branch", "-r", "--contains", commit)
  if (!pushed.ok || !pushed.out)
    refuse(
      "unpushed",
      `Your current commit ${commit.slice(0, 10)} isn't on ${remote} yet, and the worker can only start from what's there. Push it first.`,
    )
  const status = await git(directory, "status", "--porcelain")
  const uncommitted = status.out ? status.out.split("\n").map((line) => line.slice(3)) : []
  return { repo: { url: url.out, commit, branch }, root: top.out, uncommitted }
}
