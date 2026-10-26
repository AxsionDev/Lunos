// XCOD-186: stands in for the Lunos Cloud control plane in tests. It speaks contract v1
// (src/cloud/contract.ts) and also serves the OIDC discovery `CloudAuth.session()` reads. Its
// "worker" is a git clone of the requested commit in a temp directory, and DELETE commits what changed
// there to lunos/cloud/<id> and pushes that branch, like the real one. Not a control plane: no
// isolation, metering or limits, which are the commercial side's.
//
// XCOD-236: `directory` in the Worker is the project directory *on the worker* (contract.ts), not a
// path on the client's machine: without `serve` it is "/workspace", as on the real control plane, and
// a test that plays the agent writes into the clone through `tree(id)`, which only the fake has.
//
// With `serve`, each worker also runs a real `lunos serve` in its clone, so `lunos run --cloud` can
// attach to it. That server is on this machine, so `directory` is the clone's path: still the
// server's view of it, which is all the client may use it for. The worker gets the residency policy
// the client sent as locked managed config, as the real one does, so the worker enforces it.
//
// XCOD-237: `end(id, reason, message)` stops a run the way the control plane does when billing
// stops it mid-run (spending cap reached, subscription suspended): the Worker gains `ended`, then the
// busy sessions on the worker's server are aborted. The worker itself stays up, so DELETE still
// pushes the results.
// Run standalone for a local end-to-end check (any bearer token is accepted):
//
//   bun test/cloud/fixtures/fake-control-plane.ts     # prints the endpoint to set as cloud.endpoint
import fs from "fs/promises"
import os from "os"
import path from "path"
import { $, type Subprocess } from "bun"

export const TOKEN = "test-access-token"
/**
 * Present only in this fake. lunoshq's conformance shim replaces this module with the real control
 * plane (exporting just TOKEN and start), so tests that need the fake's test-only hooks (`end`,
 * `fail` without a message) check this and skip there.
 */
export const IS_FAKE = true
/** Where a worker without a server says its project is: a path on the worker, not here. */
export const WORKSPACE = "/workspace"

export interface Options {
  region?: "eu" | "us" | "other"
  /**
   * Answer every request to this path prefix with this status and error code. Without `message`
   * the body has none (`raw` sends a body that isn't the error shape at all).
   */
  fail?: { path: string; status: number; code: string; message?: string; raw?: boolean }
  /** Reports a different results branch, to check the client refuses it. */
  wrongBranch?: boolean
  /** Accept any bearer token, for standalone use with a real `lunos login`. */
  anyToken?: boolean
  /** Path to Lunos's entry point: run a real `lunos serve` in each worker's clone. */
  serve?: string
  /** Extra environment for each worker's `lunos serve` (tests: no network, no plugins). */
  serveEnv?: Record<string, string>
  port?: number
}

type Worker = {
  id: string
  dir: string
  commit: string
  polls: number
  started: number
  server?: { proc: Subprocess; url: string }
  ended?: { reason: string; message: string }
}

// The worker's server sees none of this machine's environment or stored logins: only PATH, its own
// home, the password and the secrets the client named, as a real worker would.
async function serve(
  entry: string,
  dir: string,
  password: string,
  secrets: Record<string, string>,
  residency: { allow: string[] } | null | undefined,
  extra: Record<string, string> = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-worker-home-"))
  const managed = path.join(home, "managed")
  await fs.mkdir(managed)
  if (residency)
    await fs.writeFile(
      path.join(managed, "managed.json"),
      JSON.stringify({ residency: { allow: residency.allow }, $locked: ["residency"] }),
    )
  const proc = Bun.spawn(["bun", entry, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: managed,
      OPENCODE_SERVER_PASSWORD: password,
      ...extra,
      ...secrets,
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`lunos serve exited without a URL: ${seen}`)
    seen += decoder.decode(value)
    const url = /https?:\/\/127\.0\.0\.1:\d+/.exec(seen)?.[0]
    if (url) {
      // Keep reading, or the server blocks on a full pipe the next time it logs.
      void (async () => {
        while (!(await reader.read()).done);
      })().catch(() => {})
      return { proc, url }
    }
  }
}

export async function start(options: Options = {}) {
  const requests: { method: string; path: string; auth: string | null; body?: any }[] = []
  const workers = new Map<string, Worker>()
  const region = options.region ?? "eu"
  const error = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status })

  const view = (w: Worker) => ({
    id: w.id,
    status: w.polls > 0 ? "running" : "starting",
    region,
    url: w.server?.url ?? `${server.url.origin}/worker/${w.id}`,
    auth: { username: "opencode", password: `pw-${w.id}` },
    directory: w.server ? w.dir : WORKSPACE,
    branch: options.wrongBranch ? "main" : `lunos/cloud/${w.id}`,
    activeSeconds: Math.round((Date.now() - w.started) / 1000),
    ...(w.ended ? { ended: w.ended } : {}),
  })

  const server: Bun.Server<undefined> = Bun.serve({
    port: options.port ?? 0,
    idleTimeout: 120,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const body = req.method === "PUT" ? await req.json() : undefined
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body })
      if (url.pathname === "/oidc/.well-known/openid-configuration")
        return Response.json({
          issuer: `${server.url.origin}/oidc`,
          device_authorization_endpoint: `${server.url.origin}/oidc/device`,
          token_endpoint: `${server.url.origin}/oidc/token`,
        })
      if (options.fail && url.pathname.startsWith(options.fail.path)) {
        if (options.fail.raw) return new Response("Payment Required", { status: options.fail.status })
        return error(options.fail.status, options.fail.code, options.fail.message ?? "")
      }
      const auth = req.headers.get("authorization")
      if (options.anyToken ? !auth?.startsWith("Bearer ") : auth !== `Bearer ${TOKEN}`)
        return error(401, "unauthenticated", "Sign-in expired.")
      if (url.pathname === "/v1") return Response.json({ api: 1, region, name: "fake" })
      const match = /^\/v1\/workers\/([a-z0-9]+)$/.exec(url.pathname)
      if (!match) return error(404, "not_found", "No such route")
      const id = match[1]
      if (req.method === "PUT") {
        const existing = workers.get(id)
        if (existing) return Response.json(view(existing))
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-worker-"))
        const cloned = await $`git clone -q ${body.repo.url} ${dir}`.quiet().nothrow()
        if (cloned.exitCode !== 0) {
          await fs.rm(dir, { recursive: true, force: true })
          return error(502, "repo_unreachable", `The worker couldn't clone ${body.repo.url}`)
        }
        await $`git -C ${dir} checkout -q ${body.repo.commit}`.quiet()
        const worker: Worker = { id, dir, commit: body.repo.commit, polls: 0, started: Date.now() }
        if (options.serve)
          worker.server = await serve(
            options.serve,
            dir,
            `pw-${id}`,
            body.secrets ?? {},
            body.residency,
            options.serveEnv,
          )
        workers.set(id, worker)
        return Response.json(view(worker), { status: 201 })
      }
      const worker = workers.get(id)
      if (!worker) return error(404, "not_found", `No worker ${id}`)
      if (req.method === "GET") {
        worker.polls++
        return Response.json(view(worker))
      }
      if (req.method === "DELETE") {
        worker.server?.proc.kill()
        await worker.server?.proc.exited
        const branch = `lunos/cloud/${id}`
        const changed = (await $`git -C ${worker.dir} status --porcelain`.quiet().text()).trim()
        let commit: string | undefined
        if (changed) {
          await $`git -C ${worker.dir} checkout -q -b ${branch}`.quiet()
          await $`git -C ${worker.dir} add -A`.quiet()
          await $`git -C ${worker.dir} -c user.email=worker@lunos.test -c user.name=worker commit -qm ${`Lunos Cloud run ${id}`}`.quiet()
          await $`git -C ${worker.dir} push -q origin ${branch}`.quiet()
          commit = (await $`git -C ${worker.dir} rev-parse HEAD`.quiet().text()).trim()
        }
        const activeSeconds = view(worker).activeSeconds
        workers.delete(id)
        await fs.rm(worker.dir, { recursive: true, force: true })
        return Response.json({ id, status: "destroyed", branch, pushed: !!changed, commit, activeSeconds })
      }
      return error(404, "not_found", "No such route")
    },
  })

  return {
    url: server.url.origin,
    issuer: `${server.url.origin}/oidc`,
    requests,
    workers,
    /** The worker's clone on this machine, for a test playing the agent. Not part of the contract. */
    tree: (id: string) => {
      const worker = workers.get(id)
      if (!worker) throw new Error(`No worker ${id}`)
      return worker.dir
    },
    /** Stops the run as billing does mid-run: `ended` first, then the busy sessions are aborted. */
    end: async (id: string, reason: string, message: string) => {
      const worker = workers.get(id)
      if (!worker) throw new Error(`No worker ${id}`)
      worker.ended = { reason, message }
      if (!worker.server) return
      const headers = { authorization: `Basic ${Buffer.from(`opencode:pw-${id}`).toString("base64")}` }
      const at = (pathname: string) => `${worker.server!.url}${pathname}?directory=${encodeURIComponent(worker.dir)}`
      const status = (await fetch(at("/session/status"), { headers }).then((r) => r.json())) as Record<
        string,
        { type: string }
      >
      for (const [sid, s] of Object.entries(status))
        if (s.type !== "idle") await fetch(at(`/session/${encodeURIComponent(sid)}/abort`), { method: "POST", headers })
    },
    stop: () => {
      for (const worker of workers.values()) worker.server?.proc.kill()
      server.stop(true)
    },
  }
}

if (import.meta.main) {
  const entry = path.join(import.meta.dir, "../../../src/index.ts")
  const fake = await start({ anyToken: true, serve: entry, port: Number(process.env.PORT ?? 0) })
  console.log(`fake Lunos Cloud control plane: ${fake.url}`)
  console.log(`  lunos settings set cloud.endpoint ${fake.url}`)
  console.log(`  sign in with lunos login (any issuer); every bearer token is accepted`)
}
