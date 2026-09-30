import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Global } from "@opencode-ai/core/global"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { SandboxConfig } from "./config"
import { SandboxDocker } from "./docker"
import { SandboxGit } from "./git"

// XCOD-144 slice 1: the lifecycle of one sandbox. `create` copies the repo into a container volume
// and creates (but doesn't start) the container; `start` runs the Lunos server in it; `handoff`
// brings the results back to the host (transcript, then branch); `finish` applies on_finish, and
// only after a successful handoff — a failed one always retains.
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
  resources: SandboxConfig.Resolved["resources"]
  password: string
  created: string
  /** The commit the branch was last set to; absent until the first successful handoff. */
  handedOff?: string
}

export type Connection = { url: string; password: string; headers: Record<string, string>; directory: string }

export type Handoff = {
  branch: string
  commit: string
  files: { status: string; path: string }[]
  results: string
}

export const branchName = (id: string) => `lunos/sandbox/${id}`

const metaDir = () => path.join(Global.Path.state, "sandbox")
const metaFile = (id: string) => path.join(metaDir(), `${id}.json`)
export const resultsDir = (root: string, id: string) => path.join(root, ".opencode", "sandbox", id)

async function saveMeta(meta: Meta) {
  await fs.mkdir(metaDir(), { recursive: true, mode: 0o700 })
  await fs.writeFile(metaFile(meta.id), JSON.stringify(meta, null, 2), { mode: 0o600 })
}

export async function meta(id: string): Promise<Meta> {
  const text = await fs.readFile(metaFile(id), "utf8").catch(() => undefined)
  if (!text) throw new Error(`No sandbox ${id}. \`lunos sandbox list\` shows the ones that exist`)
  return JSON.parse(text) as Meta
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
  /** Values injected at run time as environment, e.g. OPENCODE_AUTH_CONTENT. Never written to disk. */
  secrets?: Record<string, string>
  log?: (line: string) => void
}): Promise<Meta> {
  const log = input.log ?? (() => {})
  if (process.env.LUNOS_SANDBOX) throw new Error("Already running inside a sandbox; a sandbox can't start another")
  await SandboxDocker.available()
  const repo = await SandboxGit.repo(input.directory)
  const id = input.id ?? randomBytes(4).toString("hex")
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error(`Invalid sandbox id ${id}`)
  const branch = branchName(id)

  log(`image ${input.config.image}`)
  const image = await SandboxDocker.image(input.config.image)

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
      resources: input.config.resources,
      password,
      created: new Date().toISOString(),
    }
    await saveMeta(result)

    // Nothing has run yet, so a failure from here on can clean up after itself.
    try {
      await populate(result, seed, input.secrets ?? {})
    } catch (error) {
      await destroy(id).catch(() => {})
      throw error
    }
    return result
  } finally {
    await fs.rm(seed, { recursive: true, force: true })
  }
}

async function populate(info: Meta, seed: string, extraSecrets: Record<string, string>) {
  await SandboxDocker.createVolume(info.id)
  await SandboxDocker.seed(info.id, info.image.id, SandboxGit.tar(seed), SandboxGit.TAR_ENV)
  const secrets = { ...providerEnv(), ...extraSecrets, OPENCODE_SERVER_PASSWORD: info.password }
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
      secretNames: Object.keys(secrets),
    }),
    secrets,
  )
}

export function connection(info: Meta, port: number): Connection {
  return {
    url: `http://127.0.0.1:${port}`,
    password: info.password,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` },
    directory: info.directory,
  }
}

export async function start(info: Meta, timeoutMs = 60_000): Promise<Connection> {
  await SandboxDocker.start(info.id)
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

    await fs.mkdir(results, { recursive: true })
    await fs.writeFile(path.join(path.dirname(results), ".gitignore"), "*\n")
    await fs.writeFile(path.join(results, "transcript.json"), JSON.stringify(sessions, null, 2))
    await SandboxGit.setBranch({ gitDir: info.gitDir, branch: info.branch, commit, expected: previous })
    info.handedOff = commit
    await saveMeta(info)
    // Last, so a summary only ever describes a branch that exists.
    const files = await SandboxGit.changedFiles(info.gitDir, info.base, commit)
    await fs.writeFile(
      path.join(results, "summary.json"),
      JSON.stringify(
        {
          id: info.id,
          image: info.image,
          resources: info.resources,
          base: info.base,
          branch: info.branch,
          commit,
          files,
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
    return { branch: info.branch, commit, files, results }
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
}

/** Apply the lifecycle policy. Only call after a successful handoff. */
export async function finish(info: Meta, policy = info.on_finish) {
  if (policy === "destroy") return destroy(info.id)
  await SandboxDocker.stop(info.id).catch(() => {})
}

export async function destroy(id: string) {
  await SandboxDocker.remove(id)
  await fs.rm(metaFile(id), { force: true })
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
  const rows = await SandboxDocker.list()
  return Promise.all(rows.map(async (row) => ({ ...row, meta: await meta(row.id).catch(() => undefined) })))
}

export { SandboxConfig, SandboxDocker, SandboxGit }
export * as Sandbox from "."
