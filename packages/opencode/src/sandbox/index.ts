import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Global } from "@opencode-ai/core/global"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { parse } from "jsonc-parser"
import { AuditLog } from "@/audit/log"
import { SandboxConfig } from "./config"
import { SandboxDocker } from "./docker"
import { SandboxAllow } from "./allow"
import type { SandboxEgress } from "./egress"
import { SandboxGit } from "./git"

// XCOD-144 slice 1: the lifecycle of one sandbox. `create` copies the repo into a container volume
// and creates (but doesn't start) the container; `start` runs the Lunos server in it; `handoff`
// brings the results back to the host (transcript, then branch); `finish` applies on_finish, and
// only after a successful handoff — a failed one always retains.
//
// XCOD-157: secrets are no longer part of the container's configuration. `start` writes them, with
// the user's global config, into a tmpfs through `docker exec` (see boot.ts), every time it starts
// the container. The organisation's managed config goes into a read-only volume at `create`.
// Every step lands in the audit trail as a `sandbox.*` event.
//
// Host-side metadata (including the server password) is written to <state>/sandbox/<id>.json, mode
// 0600, as soon as the sandbox exists, so an interrupted run still leaves something listable and
// destroyable rather than an orphan.

export type Meta = {
  id: string
  root: string
  gitDir: string
  base: string
  /** Tree of the workspace the sandbox started with (base + uncommitted changes). */
  seedTree: string
  /** Directory inside the container that corresponds to where the user started. */
  directory: string
  branch: string
  image: SandboxDocker.Image
  on_finish: SandboxConfig.Resolved["on_finish"]
  retain_for?: number
  resources: SandboxConfig.Resolved["resources"]
  /** XCOD-158: how the results come back; absent on older sandboxes, which used "branch". */
  results?: SandboxConfig.Resolved["results"]
  /** The container runtime that created it; absent on older sandboxes, which used Docker. */
  runtime?: SandboxDocker.Runtime["name"]
  engine?: SandboxDocker.Runtime["engine"]
  /** XCOD-157: absent on sandboxes made before network policy existed, which were "open". */
  network?: SandboxConfig.Network
  /** The egress proxy's allow list ("host:port"), fixed when the sandbox was created. */
  allow?: string[]
  /** The newest egress decision already written to the audit trail. */
  egressUntil?: string
  password: string
  created: string
  /** The commit the branch was last set to; absent until the first successful handoff. */
  handedOff?: string
  /** When a retained sandbox expires (sandbox.retain_for); `prune` removes it after that. */
  expires?: string
  /** Lines of the audit log inside already copied into the host's audit trail. */
  auditLines?: number
}

export type Connection = { url: string; password: string; headers: Record<string, string>; directory: string }

export type Handoff = {
  mode: SandboxConfig.Resolved["results"]
  /** Set for "branch". */
  branch?: string
  /** Set for "patch": the file holding the agent's changes. */
  patch?: string
  /** The commit the workspace was recorded as ("branch" and "patch"), for the summary. */
  commit?: string
  files: { status: string; path: string }[]
  results: string
  /** Whether a session's last reply ended in an error: what destroy_on_success keeps a sandbox for. */
  failed: boolean
}

export const branchName = (id: string) => `lunos/sandbox/${id}`

const metaDir = () => path.join(Global.Path.state, "sandbox")
const metaFile = (id: string) => path.join(metaDir(), `${id}.json`)
export const resultsDir = (root: string, id: string) => path.join(root, ".opencode", "sandbox", id)

async function saveMeta(meta: Meta) {
  await fs.mkdir(metaDir(), { recursive: true, mode: 0o700 })
  await fs.writeFile(metaFile(meta.id), JSON.stringify(meta, null, 2), { mode: 0o600 })
}

export type Marker = {
  id: string
  image?: string
  digest?: string
  network?: SandboxConfig.Network
  results?: SandboxConfig.Resolved["results"]
  runtime?: string
  created?: string
}

export function markerOf(info: Meta): Marker {
  return {
    id: info.id,
    image: info.image.ref,
    digest: info.image.digest ?? info.image.id,
    network: info.network ?? "open",
    results: info.results ?? "branch",
    runtime: info.engine ?? info.runtime ?? "docker",
    created: info.created,
  }
}

export type Status = {
  /** Set when this server runs inside a sandbox: what it's running in. */
  inside?: Marker
  /** Sandboxes this machine holds for the project, from host metadata (no Docker call). */
  known: {
    id: string
    created: string
    branch: string
    network: string
    results?: string
    expires?: string
    handedOff?: string
  }[]
}

/**
 * For the Status tab. Inside a sandbox, the marker (only when it matches LUNOS_SANDBOX, see
 * SandboxConfig.inside); on the host, the project's sandboxes from their metadata.
 */
export async function status(root: string | undefined): Promise<Status> {
  if (SandboxConfig.inside()) {
    const marker = JSON.parse(
      await fs.readFile(path.join(SandboxDocker.POLICY_DIR, SandboxDocker.MARKER), "utf8"),
    ) as Marker
    return { inside: marker, known: [] }
  }
  return {
    known: (await known())
      .filter((info) => !root || info.root === root)
      .map((info) => ({
        id: info.id,
        created: info.created,
        branch: info.branch,
        network: info.network ?? "open",
        results: info.results ?? "branch",
        // Metadata from older sandboxes can hold null here; the snapshot's fields are optional strings.
        expires: info.expires ?? undefined,
        handedOff: info.handedOff ?? undefined,
      })),
  }
}

/** What every sandbox audit event says about the sandbox. Never file contents. */
function auditFields(info: Meta) {
  return {
    id: info.id,
    project: info.root,
    image: info.image.ref,
    digest: info.image.digest ?? info.image.id,
    cpus: info.resources.cpus,
    memory: info.resources.memory,
    pids: info.resources.pids,
    tmp: info.resources.tmp,
    network: info.network ?? "open",
  }
}

export async function meta(id: string): Promise<Meta> {
  const text = await fs.readFile(metaFile(id), "utf8").catch(() => undefined)
  if (!text) throw new Error(`No sandbox ${id}. \`lunos sandbox list\` shows the ones that exist`)
  const info = JSON.parse(text) as Meta
  SandboxDocker.use(info.runtime, info.engine)
  return info
}

/** Provider keys: whatever the host's env holds under the *_API_KEY convention. */
export function providerEnv(env: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => /^[A-Z0-9_]+_API_KEY$/.test(entry[0]) && !!entry[1],
    ),
  )
}

export async function create(input: {
  /** Chosen by the caller when it has to know it up front (the workspace adapter); random otherwise. */
  id?: string
  directory: string
  config: SandboxConfig.Resolved
  /** Provider ids the host holds credentials for: their API hosts go on the egress allow list. */
  providers?: readonly string[]
  log?: (line: string) => void
}): Promise<Meta> {
  const log = input.log ?? (() => {})
  if (process.env.LUNOS_SANDBOX) throw new Error("Already running inside a sandbox; a sandbox can't start another")
  await SandboxDocker.available(input.config.runtime)
  const repo = await SandboxGit.repo(input.directory)
  const id = input.id ?? randomBytes(4).toString("hex")
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error(`Invalid sandbox id ${id}`)
  const branch = branchName(id)

  log(`image ${input.config.image}`)
  const image = await SandboxDocker.image(input.config.image)
  const managed = await SandboxConfig.managedDoc()
  const network = input.config.network
  const computed = SandboxAllow.compute({
    doc: SandboxConfig.effectiveDoc(input.directory, managed),
    providers: [...(input.providers ?? []), ...SandboxAllow.providersFromEnv(Object.keys(providerEnv()))],
    network,
    extra: input.config.allow,
  })
  // The proxy comes from the Lunos image, or from a sandbox.image your global or managed config set;
  // never from one a repository chose, which would let it bring its own egress filter.
  const egressImage = network === "open" ? undefined : await SandboxDocker.image(input.config.egressImage)
  if (network === "open") log("network open: the sandbox can reach anything this machine can")
  else log(`network ${network}: ${network === "none" ? "nothing" : computed.allow.join(", ")} allowed`)
  for (const item of computed.denied) log(`not allowed by the residency policy: ${item.provider}`)

  const seed = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-seed-"))
  try {
    log(`copying ${repo.root} at ${repo.base.slice(0, 12)} (with uncommitted changes)`)
    await SandboxGit.seed({ ...repo, into: seed, branch })
    const seedTree = await SandboxGit.tree({
      gitDir: repo.gitDir,
      workTree: seed,
      startTree: await SandboxGit.treeOfCommit(repo.gitDir, repo.base),
    })

    const password = randomBytes(24).toString("base64url")
    const workdir = path.posix.join(SandboxDocker.WORKSPACE, repo.relative.split(path.sep).join("/"))
    const result: Meta = {
      id,
      root: repo.root,
      gitDir: repo.gitDir,
      base: repo.base,
      seedTree,
      directory: workdir,
      branch,
      image,
      on_finish: input.config.on_finish,
      retain_for: input.config.retain_for,
      resources: input.config.resources,
      results: input.config.results,
      runtime: SandboxDocker.current()?.name,
      engine: SandboxDocker.current()?.engine,
      network,
      allow: computed.allow,
      password,
      created: new Date().toISOString(),
    }
    await saveMeta(result)

    // Nothing has run yet, so a failure from here on can clean up after itself.
    try {
      await populate(result, seed, managed, egressImage)
    } catch (error) {
      await remove(id).catch(() => {})
      throw error
    }
    AuditLog.emit("sandbox.create", { ...auditFields(result), on_finish: result.on_finish })
    return result
  } finally {
    await fs.rm(seed, { recursive: true, force: true })
  }
}

async function populate(
  info: Meta,
  seed: string,
  managed: Record<string, unknown> | undefined,
  egressImage: SandboxDocker.Image | undefined,
) {
  await SandboxDocker.createVolume(info.id)
  if (egressImage)
    await SandboxDocker.createEgress({
      id: info.id,
      image: egressImage,
      allow: info.allow ?? [],
      network: info.network,
    })
  await SandboxDocker.seed(info.id, info.image.id, SandboxGit.tar(seed), SandboxGit.TAR_ENV)
  const policy = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-policy-"))
  try {
    if (managed) await fs.writeFile(path.join(policy, "managed.json"), JSON.stringify(auditInside(managed), null, 2))
    // XCOD-158: the marker also tells the server inside what it's running in (the Status tab), since
    // it can't ask Docker. Root-owned and read-only, like the rest of the policy volume.
    await fs.writeFile(path.join(policy, SandboxDocker.MARKER), JSON.stringify(markerOf(info)) + "\n")
    await SandboxDocker.seedPolicy(info.id, info.image.id, policy, SandboxGit.TAR_ENV)
  } finally {
    await fs.rm(policy, { recursive: true, force: true })
  }
  await SandboxDocker.create(
    SandboxDocker.createArgs({
      id: info.id,
      project: info.root,
      image: info.image,
      resources: info.resources,
      workdir: info.directory,
      env: {
        HOME: SandboxDocker.HOME,
        TMPDIR: "/tmp",
        LUNOS_SANDBOX: info.id,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      network: info.network,
    }),
  )
}

/**
 * Write the egress proxy's decisions since the last collection to the host's audit trail, as
 * `sandbox.egress`, and return them. Its log survives a stop, so this works on a stopped sandbox.
 */
export async function collectEgress(info: Meta): Promise<SandboxEgress.Decision[]> {
  if (!info.network || info.network === "open") return []
  const text = await SandboxDocker.egressLog(info.id).catch(() => "")
  const decisions = text
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SandboxEgress.Decision]
      } catch {
        return []
      }
    })
    .filter((item) => typeof item.time === "string" && (!info.egressUntil || item.time > info.egressUntil))
  for (const item of decisions)
    AuditLog.emit("sandbox.egress", {
      id: info.id,
      kind: item.kind,
      host: item.host,
      port: item.port,
      allowed: item.allowed,
      network: info.network,
    })
  if (decisions.length) {
    info.egressUntil = decisions.at(-1)!.time
    await saveMeta(info).catch(() => {})
  }
  return decisions
}

/**
 * The runtime file's contents: provider keys, extra secrets (e.g. OPENCODE_AUTH_CONTENT), the server
 * password, the host's OPENCODE_CONFIG_CONTENT, and the user's global config.
 */
function runtime(info: Meta, secrets: Record<string, string>) {
  // The audit path goes in OPENCODE_CONFIG_CONTENT, which outranks global and project config, so
  // whichever of them turns auditing on, the server inside writes where the host can collect it.
  const content = process.env.OPENCODE_CONFIG_CONTENT
    ? (parse(process.env.OPENCODE_CONFIG_CONTENT, [], { allowTrailingComma: true }) as unknown)
    : {}
  const env: Record<string, string> = {
    ...providerEnv(),
    ...secrets,
    OPENCODE_SERVER_PASSWORD: info.password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      SandboxConfig.mergeDocs([
        auditInside(isDoc(content) ? content : {}),
        { audit: { path: SandboxDocker.AUDIT_FILE } },
      ]),
    ),
  }
  return JSON.stringify({ env, config: auditInside(SandboxConfig.globalDoc()) })
}

const isDoc = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/**
 * A config document as the server inside should see it: its audit log at AUDIT_FILE, and no audit
 * forwarding (the host forwards the sandbox's events once it has collected them, see `handoff`).
 */
export function auditInside(doc: Record<string, unknown>) {
  const out = { ...doc }
  if (isDoc(out.audit)) {
    const { forward: _forward, ...audit } = out.audit
    out.audit = { ...audit, path: SandboxDocker.AUDIT_FILE }
  }
  if (isDoc(out.residency) && out.residency.auditPath !== undefined)
    out.residency = { ...out.residency, auditPath: SandboxDocker.AUDIT_FILE }
  return out
}

/**
 * The audit log written inside, since the last collection: copied whole to the results directory,
 * and each new event written to the host's audit trail tagged with the sandbox id, so there is one
 * trail (and one forwarder). The original time is kept as `sandbox_time`.
 */
async function collectAudit(info: Meta, results: string) {
  const text = await SandboxDocker.readFile(info.id, SandboxDocker.AUDIT_FILE)
  if (!text) return 0
  await fs.writeFile(path.join(results, "audit.log"), text)
  const lines = text.split("\n").filter(Boolean)
  for (const line of lines.slice(info.auditLines ?? 0)) {
    try {
      const { v: _v, seq: _seq, prev: _prev, event, timestamp, ...fields } = JSON.parse(line) as Record<string, never>
      AuditLog.emit(event, { ...fields, sandbox: info.id, sandbox_time: timestamp })
    } catch {
      // A line the agent mangled is still in the copy; it just isn't re-emitted.
    }
  }
  const added = lines.length - (info.auditLines ?? 0)
  info.auditLines = lines.length
  return added
}

export function connection(info: Meta, port: number): Connection {
  return {
    url: `http://127.0.0.1:${port}`,
    password: info.password,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` },
    directory: info.directory,
  }
}

export async function start(
  info: Meta,
  options: { secrets?: Record<string, string>; attach?: boolean; timeoutMs?: number } = {},
): Promise<Connection> {
  const timeoutMs = options.timeoutMs ?? 60_000
  await SandboxDocker.start(info.id)
  await SandboxDocker.inject(info.id, runtime(info, options.secrets ?? {}))
  if (options.attach) AuditLog.emit("sandbox.attach", auditFields(info))
  const conn = connection(info, await SandboxDocker.hostPort(info.id))
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // Docker Desktop accepts on the published port before the server listens, and such a connection
    // can hang, so every probe gets its own short timeout.
    const ok = await fetch(`${conn.url}/global/health`, { headers: conn.headers, signal: AbortSignal.timeout(2000) })
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return conn
    await sleep(250)
  }
  throw new Error(
    `The sandbox server didn't become healthy within ${timeoutMs / 1000}s. Last log lines:\n${await SandboxDocker.logs(info.id)}`,
  )
}

/** Every session the sandbox server holds, with its messages. */
async function transcript(conn: Connection) {
  const client = createOpencodeClient({ baseUrl: conn.url, headers: conn.headers, directory: conn.directory })
  const sessions = (await client.session.list({}, { throwOnError: true })).data ?? []
  return Promise.all(
    sessions.map(async (session) => ({
      session,
      messages: (await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data ?? [],
    })),
  )
}

/**
 * A task failed when a session's last message is an assistant reply that didn't finish normally: it
 * ended in an error, or it stopped mid-task (a rejected or failed tool call leaves `finish` at
 * "tool-calls", and a truncated reply at "length").
 */
export function failed(sessions: { messages: { info: { role: string; error?: unknown; finish?: string } }[] }[]) {
  return sessions.some((item) => {
    const last = item.messages.at(-1)?.info
    if (last?.role !== "assistant") return false
    return !!last.error || (last.finish !== undefined && last.finish !== "stop")
  })
}

/**
 * Bring the results back to the host: the transcript and a summary into .opencode/sandbox/<id>/,
 * then the workspace as commits on lunos/sandbox/<id>. Needs the server running (for the
 * transcript); stops the container before copying the workspace out, so the copy is consistent.
 */
export async function handoff(info: Meta, conn: Connection, extra: Record<string, unknown> = {}): Promise<Handoff> {
  const results = resultsDir(info.root, info.id)
  const sessions = await transcript(conn)
  await SandboxDocker.stop(info.id)

  const out = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-out-"))
  try {
    const mode = info.results ?? "branch"
    await fs.mkdir(results, { recursive: true })
    await fs.writeFile(path.join(path.dirname(results), ".gitignore"), "*\n")
    await fs.writeFile(path.join(results, "transcript.json"), JSON.stringify(sessions, null, 2))
    await collectAudit(info, results)
    const summary = (fields: Record<string, unknown>) =>
      fs.writeFile(
        path.join(results, "summary.json"),
        JSON.stringify(
          {
            id: info.id,
            image: info.image,
            resources: info.resources,
            network: info.network ?? "open",
            base: info.base,
            results: mode,
            ...fields,
            sessions: sessions.map((item) => ({
              id: item.session.id,
              title: item.session.title,
              messages: item.messages.length,
            })),
            created: info.created,
            finished: new Date().toISOString(),
            ...extra,
          },
          null,
          2,
        ),
      )
    if (mode === "none") {
      await summary({ files: [] })
      return { mode, files: [], results, failed: failed(sessions) }
    }

    await SandboxDocker.copyOut(info.id, out)
    const workTree = path.join(out, path.posix.basename(SandboxDocker.WORKSPACE))
    const previous = info.handedOff
    let parent = previous ?? info.base
    if (!previous && info.seedTree !== (await SandboxGit.treeOfCommit(info.gitDir, info.base))) {
      parent = await SandboxGit.commit({
        gitDir: info.gitDir,
        tree: info.seedTree,
        parent,
        message: `sandbox ${info.id}: uncommitted changes the sandbox started from`,
      })
    }
    const tree = await SandboxGit.tree({ gitDir: info.gitDir, workTree, startTree: info.seedTree })
    const commit =
      tree === (await SandboxGit.treeOfCommit(info.gitDir, parent))
        ? parent
        : await SandboxGit.commit({ gitDir: info.gitDir, tree, parent, message: `sandbox ${info.id}: agent changes` })

    if (mode === "patch") {
      // Only the agent's changes: from the tree the sandbox started with, not from the base commit.
      const patch = path.join(results, "changes.patch")
      await fs.writeFile(patch, await SandboxGit.diff(info.gitDir, info.seedTree, tree))
      info.handedOff = commit
      await saveMeta(info)
      const files = await SandboxGit.changedFiles(info.gitDir, info.seedTree, tree)
      await summary({ patch, commit, files })
      return { mode, patch, commit, files, results, failed: failed(sessions) }
    }
    await SandboxGit.setBranch({ gitDir: info.gitDir, branch: info.branch, commit, expected: previous })
    info.handedOff = commit
    await saveMeta(info)
    // Last, so a summary only ever describes a branch that exists.
    const files = await SandboxGit.changedFiles(info.gitDir, info.base, commit)
    await summary({ branch: info.branch, commit, files })
    return { mode, branch: info.branch, commit, files, results, failed: failed(sessions) }
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
}

/** Whether a policy destroys the sandbox, given how the task went. */
export function destroys(policy: Meta["on_finish"], outcome: { failed: boolean }) {
  return policy === "destroy" || (policy === "destroy_on_success" && !outcome.failed)
}

/**
 * Apply the lifecycle policy. Only call after a successful handoff. Returns what happened; a kept
 * sandbox gets its expiry (sandbox.retain_for) recorded, for `prune`.
 */
export async function finish(
  info: Meta,
  outcome: { failed: boolean; commit?: string; files?: number },
  policy = info.on_finish,
): Promise<"destroyed" | "retained"> {
  AuditLog.emit("sandbox.finish", {
    ...auditFields(info),
    outcome: outcome.failed ? "failed" : "succeeded",
    commit: outcome.commit,
    files: outcome.files,
    on_finish: policy,
  })
  if (destroys(policy, outcome)) {
    await destroy(info.id, "on_finish")
    return "destroyed"
  }
  await retain(info, "on_finish")
  return "retained"
}

/** Stop and keep. Used by `finish` and whenever the results couldn't be handed back. */
export async function retain(info: Meta, reason: string) {
  await SandboxDocker.stop(info.id).catch(() => {})
  await collectEgress(info)
  if (info.retain_for) {
    info.expires = new Date(Date.now() + info.retain_for).toISOString()
    await saveMeta(info)
  }
  AuditLog.emit("sandbox.retain", { ...auditFields(info), reason, expires: info.expires })
}

/** Remove the container, its volumes and the host metadata, without an audit event. */
async function remove(id: string) {
  await SandboxDocker.remove(id)
  await fs.rm(metaFile(id), { force: true })
}

export async function destroy(id: string, reason = "requested") {
  const info = await meta(id).catch(() => undefined)
  if (info) await collectEgress(info)
  await remove(id)
  AuditLog.emit("sandbox.destroy", info ? { ...auditFields(info), reason } : { id, reason })
}

/** Retained sandboxes whose sandbox.retain_for has run out, from the host metadata alone. */
export async function expired(now = Date.now()) {
  return (await known()).filter((info) => info.expires !== undefined && Date.parse(info.expires) <= now)
}

/**
 * Remove every expired sandbox. Reads only the host metadata unless something has expired, so it's
 * cheap enough to run at every start; Docker is only called for a sandbox that is due.
 */
export async function prune(now = Date.now()) {
  const due = await expired(now)
  const removed: string[] = []
  for (const info of due) {
    await collectEgress(info)
    await remove(info.id)
    AuditLog.emit("sandbox.prune", { ...auditFields(info), expires: info.expires })
    removed.push(info.id)
  }
  return removed
}

/** Sandboxes this machine created, from the host metadata alone: no Docker call. */
export async function known(): Promise<Meta[]> {
  const names = await fs.readdir(metaDir()).catch(() => [] as string[])
  const all = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => meta(name.slice(0, -".json".length)).catch(() => undefined)),
  )
  return all.filter((item): item is Meta => item !== undefined)
}

export async function list() {
  await SandboxDocker.available()
  const rows = await SandboxDocker.list()
  return Promise.all(rows.map(async (row) => ({ ...row, meta: await meta(row.id).catch(() => undefined) })))
}

export { SandboxConfig, SandboxDocker, SandboxGit }
export * as Sandbox from "."
