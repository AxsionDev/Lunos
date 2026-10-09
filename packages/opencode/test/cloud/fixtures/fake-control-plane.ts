// XCOD-186: stands in for the Lunos Cloud control plane in tests. It speaks contract v1
// (src/cloud/contract.ts) and also serves the OIDC discovery `CloudAuth.session()` reads. Its
// "worker" is a git clone of the requested commit in a temp directory: a test writes files there as
// an agent would, and DELETE commits them to lunos/cloud/<id> and pushes that branch, like the
// real one. Not a control plane: no isolation, metering or limits, which are the commercial side's.
//
// With `serve`, each worker also runs a real `lunos serve` in its clone, so `lunos run --cloud` can
// attach to it. Run standalone for a local end-to-end check (any bearer token is accepted):
//
//   bun test/cloud/fixtures/fake-control-plane.ts     # prints the endpoint to set as cloud.endpoint
import fs from "fs/promises"
import os from "os"
import path from "path"
import { $, type Subprocess } from "bun"

export const TOKEN = "test-access-token"

export interface Options {
  region?: "eu" | "us" | "other"
  /** Answer every request to this path prefix with this status and error code. */
  fail?: { path: string; status: number; code: string; message: string }
  /** Reports a different results branch, to check the client refuses it. */
  wrongBranch?: boolean
  /** Accept any bearer token, for standalone use with a real `lunos login`. */
  anyToken?: boolean
  /** Path to Lunos's entry point: run a real `lunos serve` in each worker's clone. */
  serve?: string
  port?: number
}

type Worker = {
  id: string
  dir: string
  commit: string
  polls: number
  started: number
  server?: { proc: Subprocess; url: string }
}

// The worker's server sees none of this machine's environment or stored logins: only PATH, its own
// home, the password and the secrets the client named, as a real worker would.
async function serve(entry: string, dir: string, password: string, secrets: Record<string, string>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-worker-home-"))
  const proc = Bun.spawn(["bun", entry, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_SERVER_PASSWORD: password,
      ...secrets,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`lunos serve exited without a URL: ${seen}`)
    seen += decoder.decode(value)
    const url = /https?:\/\/127\.0\.0\.1:\d+/.exec(seen)?.[0]
    if (url) return { proc, url }
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
    directory: w.dir,
    branch: options.wrongBranch ? "main" : `lunos/cloud/${w.id}`,
    activeSeconds: Math.round((Date.now() - w.started) / 1000),
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
      if (options.fail && url.pathname.startsWith(options.fail.path))
        return error(options.fail.status, options.fail.code, options.fail.message)
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
        if (options.serve) worker.server = await serve(options.serve, dir, `pw-${id}`, body.secrets ?? {})
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
