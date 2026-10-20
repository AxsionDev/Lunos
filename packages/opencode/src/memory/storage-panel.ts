export * as MemoryStoragePanel from "./storage-panel"

import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { MemorySetup } from "@opencode-ai/core/memory-setup"
import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import type { ConfigMemory } from "@opencode-ai/core/config/memory"
import { AuditLog } from "@/audit/log"
import { Config } from "@/config/config"
import { ConfigSettings } from "@/config/settings"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "."
import { MemoryExternal } from "./external"
import { MemorySetupCheck } from "./setup-check"
import { MemorySetupEnv } from "./setup-env"
import { MemoryTemplate } from "./template"

// The Storage panel at the top of /memory's Overview, and the block `lunos memory status` prints:
// what memory uses (this computer, a database in Docker, a team database or a managed cloud one),
// the template that set it up, and its live status. Credentials are never read into it: only the
// `{env:}` / `{file:}` references the config names. Docker is asked through an injectable `exec`,
// so tests use fakes.

export type Exec = (argv: string[]) => Promise<{ code: number; stdout: string }>

const exec: Exec = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { code, stdout }
  } catch {
    return { code: -1, stdout: "" }
  }
}

/** A compose project's container: its name, image and state, from `docker`/`podman ps` and `inspect`. */
export async function container(input: {
  tool: "docker" | "podman" | undefined
  project: string
  exec?: Exec
}): Promise<NonNullable<MemoryStorage.Panel["container"]>> {
  const run = input.exec ?? exec
  const tool = input.tool
  if (!tool) return { tool: "docker", project: input.project, state: "no-docker" }
  const listed = await run([
    tool,
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${input.project}`,
    "--format",
    "{{.Names}}",
  ])
  const name = listed.code === 0 ? listed.stdout.trim().split("\n")[0]?.trim() : undefined
  if (!name) return { tool, project: input.project, state: "missing" }
  const inspected = await run([tool, "inspect", "-f", "{{.State.Status}}|{{.Config.Image}}", name])
  if (inspected.code !== 0) return { tool, project: input.project, name, state: "missing" }
  const [status, image] = inspected.stdout.trim().split("|")
  return {
    tool,
    project: input.project,
    name,
    ...(image ? { image } : {}),
    state: status === "running" ? "running" : "stopped",
  }
}

/** `docker start <name>`; only ever called after the user confirmed it. */
export async function start(input: { tool: "docker" | "podman"; name: string; exec?: Exec }) {
  const run = input.exec ?? exec
  const result = await run([input.tool, "start", input.name])
  return result.code === 0
}

/** A URL without user or password, for showing. */
export function sanitize(url: string | undefined) {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (!parsed.username && !parsed.password) return url
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return url.replace(/\/\/[^@/]*@/, "//")
  }
}

/** Total size of the files under these directories. */
export async function bytes(dirs: readonly string[]) {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile())
        total += await fs.stat(file).then(
          (stat) => stat.size,
          () => 0,
        )
    }
  }
  for (const dir of dirs) await walk(dir)
  return total
}

type Check = NonNullable<MemoryStorage.Panel["status"]>

// The last Test connection per storage, for "checked 2 min ago". Kept for the life of the server.
const checks = new Map<string, Check>()

function key(memory: ConfigMemory.Info | undefined) {
  const backend = MemoryExternal.configured(memory)
  return backend ? `${backend.type}|${backend.url ?? ""}` : "embedded"
}

export function record(memory: ConfigMemory.Info | undefined, check: Check) {
  checks.set(key(memory), check)
}

type Rows = Awaited<ReturnType<typeof ConfigSettings.list>>

const rowsOf = Effect.fn("MemoryStoragePanel.rows")(function* () {
  const config = yield* Config.Service
  const cfg = yield* config.get()
  const origins = yield* config.origins()
  const instance = yield* InstanceState.context
  const locked = yield* Effect.promise(() => ConfigSettings.lockedKeys())
  return yield* Effect.promise(() =>
    ConfigSettings.list({
      config: cfg,
      origins,
      locked,
      ctx: { directory: instance.directory, worktree: instance.worktree },
    }),
  )
})

function raw(rows: Rows, key: string) {
  return rows.find((row) => row.key === key)?.value
}

/** The template the config names, with the scope its files are in. */
async function templateOf(input: { rows: Rows; templates: readonly MemoryStorage.Listed[]; worktree: string }) {
  const name = raw(input.rows, "memory.template")
  if (typeof name !== "string" || !name) return undefined
  const found = MemoryStorage.find(input.templates, name) ?? MemoryStorage.BUILTIN.find((item) => item.name === name)
  const source = input.rows.find((row) => row.key === "memory.template")?.source
  let scope: MemoryTemplate.Scope | undefined =
    source === "project" ? "project" : source === "user" ? "user" : undefined
  // A Docker template's files: in the scope its config is in, else wherever they are.
  if (found?.compose) {
    const exists = (at: MemoryTemplate.Scope) =>
      fs.stat(path.join(MemoryTemplate.dir(at, name, input.worktree), "docker-compose.yml")).then(
        () => true,
        () => false,
      )
    if (!scope || !(await exists(scope)))
      scope = (await exists("project")) ? "project" : (await exists("user")) ? "user" : (scope ?? "user")
  }
  return { name, title: found?.title ?? name, template: found, scope }
}

/** The memory block a test connects with: the config's, with a Docker template's `.env` layered under it. */
const resolved = Effect.fn("MemoryStoragePanel.resolved")(function* (rows: Rows) {
  const cfg = yield* Config.Service.use((config) => config.get())
  const instance = yield* InstanceState.context
  const { templates } = yield* MemorySetupEnv.environment()
  const template = yield* Effect.promise(() => templateOf({ rows, templates, worktree: instance.worktree }))
  if (!template?.template?.compose || !template.scope || !cfg.memory?.backend) return cfg.memory
  const env = yield* Effect.promise(() =>
    MemoryTemplate.env(MemoryTemplate.dir(template.scope!, template.name, instance.worktree)),
  )
  const backend = { ...cfg.memory.backend }
  // Only the credentials that came out empty: the server wasn't started with the .env loaded, so
  // they come from the template's .env.
  for (const field of ["username", "password"] as const) {
    const value = raw(rows, `memory.backend.${field}`)
    if (!backend[field] && typeof value === "string")
      backend[field] = String((yield* Effect.promise(() => MemoryTemplate.resolve({ value }, env))).value ?? "")
  }
  return { ...cfg.memory, backend } as ConfigMemory.Info
})

/** The panel, from the config, this machine and (for a database, when memory is on) a live connection. */
export const load = Effect.fn("MemoryStoragePanel.load")(function* (input?: {
  exec?: Exec
  now?: number
  /** Already read by the caller (`lunos memory status`), so the database isn't connected to twice. */
  where?: Memory.Where
}) {
  const memory = yield* Memory.Service
  const cfg = yield* Config.Service.use((config) => config.get())
  const instance = yield* InstanceState.context
  const rows = yield* rowsOf()
  const verdict = yield* memory.decision()
  const policy = yield* memory.policy()
  const { environment, templates } = yield* MemorySetupEnv.environment()
  const template = yield* Effect.promise(() => templateOf({ rows, templates, worktree: instance.worktree }))
  const type = MemoryExternal.type(cfg.memory)
  // The same rule as the wizard and `lunos memory storage set`: a lock on memory or memory.backend.
  const locked = MemorySetup.locked(rows, "memory.backend")
  const base = {
    on: verdict.on,
    ...(verdict.on ? {} : { reason: verdict.reason }),
    locked,
    encryption: policy.encryption,
    ...(policy.retention.days ? { retentionDays: policy.retention.days } : {}),
    ...(template ? { template: { name: template.name, title: template.title, scope: template.scope } } : {}),
  }
  const last = checks.get(key(cfg.memory))
  const off = { state: "off" as const }

  if (type === "embedded") {
    const paths = [environment.paths.project, environment.paths.user].filter((item): item is string => !!item)
    return {
      ...base,
      place: "embedded" as const,
      vendor: "embedded" as const,
      leaves: template?.template?.leaves
        ? `${template.template.leaves}.`
        : MemoryStorage.leaves("embedded", environment),
      paths,
      bytes: yield* Effect.promise(() => bytes(paths)),
      ...(environment.model ? { model: environment.model } : {}),
      status: verdict.on ? (last ?? { state: "unchecked" as const }) : off,
    } satisfies MemoryStorage.Panel
  }

  const backend = MemoryExternal.configured(cfg.memory)!
  const url = sanitize(
    typeof raw(rows, "memory.backend.url") === "string" ? String(raw(rows, "memory.backend.url")) : backend.url,
  )
  const host = (() => {
    try {
      return new URL(backend.url ?? "").hostname || undefined
    } catch {
      return undefined
    }
  })()
  const credentials = ["username", "password"].flatMap((field) => {
    const name = MemoryStorage.reference(raw(rows, `memory.backend.${field}`))
    return name ? [name] : []
  })
  const place: MemoryStorage.Place = template?.template?.compose
    ? "docker"
    : template?.name === "managed-cloud"
      ? "cloud"
      : "team"
  const residency = (() => {
    try {
      MemoryExternal.gate({ memory: cfg.memory, residency: AuditLog.residency(cfg) })
      return { allowed: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return error instanceof MemoryExternal.DeniedError ? { allowed: false, reason: message } : { allowed: true }
    }
  })()
  const tls = (() => {
    try {
      return MemoryExternal.gate({ memory: cfg.memory, residency: undefined }).tls
    } catch {
      return undefined
    }
  })()
  const box =
    place === "docker" && template?.scope
      ? yield* Effect.promise(() =>
          container({
            tool: environment.docker?.tool,
            project: MemoryTemplate.project(template.scope!, template.name, instance.worktree),
            exec: input?.exec,
          }),
        )
      : undefined

  // When memory is on, the connection is checked now, the way `lunos memory status` does.
  let status: Check = off
  if (verdict.on) {
    const where = input?.where ?? (yield* memory.where())
    const at = new Date(input?.now ?? Date.now()).toISOString()
    const failed = where.scopes.find((item) => item.error)
    if (where.connection?.startsWith("ok ")) {
      status = { state: "connected", at, server: where.connection.slice(4, -1) }
      if (last?.ms !== undefined && last.state === "connected") status.ms = last.ms
    } else if (failed || where.connection) {
      const message = failed?.error ?? where.connection ?? "failed"
      const refused = message.startsWith("refused before connecting: ")
      status = {
        state: "unreachable",
        at,
        error: {
          stage: refused ? (residency.allowed ? "settings" : "residency") : "connect",
          message: refused ? message.slice("refused before connecting: ".length) : message,
          ...(MemoryExternal.probeFix(refused ? "settings" : "connect", message)
            ? { fix: MemoryExternal.probeFix(refused ? "settings" : "connect", message) }
            : {}),
        },
      }
    } else status = last ?? { state: "unchecked" }
    checks.set(key(cfg.memory), status)
  }

  return {
    ...base,
    place,
    vendor: backend.type as MemoryStorage.Kind,
    leaves: template?.template?.leaves
      ? `${template.template.leaves}.`
      : MemoryStorage.leaves(backend.type, undefined, host),
    ...(url ? { url } : {}),
    ...(host ? { host } : {}),
    ...(backend.jurisdiction ? { jurisdiction: backend.jurisdiction } : {}),
    ...(tls ? { tls } : {}),
    readOnly: backend.read_only === true,
    credentials,
    ...(place === "cloud"
      ? { provider: MemoryStorage.cloudProvider(backend.type as MemoryStorage.Kind, host), residency }
      : {}),
    ...(box ? { container: box } : {}),
    status,
  } satisfies MemoryStorage.Panel
})

/**
 * Test connection: for a database, connect, write, read and delete a probe; on this computer, the
 * memory check (remember, recall and remove a test fact). The result is what "checked" shows.
 */
export const test = Effect.fn("MemoryStoragePanel.test")(function* () {
  const cfg = yield* Config.Service.use((config) => config.get())
  const instance = yield* InstanceState.context
  const rows = yield* rowsOf()
  const started = Date.now()
  const at = () => new Date().toISOString()
  if (MemoryExternal.type(cfg.memory) === "embedded") {
    const result = yield* Effect.promise(() => MemorySetupCheck.run({ directory: instance.directory, memory: {} }))
    const check: Check = result.ok
      ? { state: "connected", at: at(), ms: Date.now() - started, server: "this computer" }
      : {
          state: "unreachable",
          at: at(),
          error: {
            stage: result.stage ?? "check",
            message: result.error ?? "The check failed and gave no reason",
            ...(result.fix ? { fix: result.fix } : {}),
          },
        }
    record(cfg.memory, check)
    return check
  }
  const memory = yield* resolved(rows)
  const result = yield* Effect.promise(() => MemoryExternal.probe({ memory, residency: AuditLog.residency(cfg) }))
  const check: Check = result.ok
    ? { state: "connected", at: at(), ms: result.ms, server: result.server }
    : {
        state: "unreachable",
        at: at(),
        error: {
          stage: result.error.stage,
          message: result.error.message,
          ...(result.error.fix ? { fix: result.error.fix } : {}),
        },
      }
  record(cfg.memory, check)
  return check
})

/** Start container: the Docker template's stopped container. */
export const startContainer = Effect.fn("MemoryStoragePanel.startContainer")(function* (input?: { exec?: Exec }) {
  const panel: MemoryStorage.Panel = yield* load(input)
  const box = panel.container
  if (!box?.name || box.state !== "stopped")
    return {
      ok: false,
      error: box ? `The container is ${box.state}, not stopped` : "Memory doesn't use a Docker container",
    }
  const ok = yield* Effect.promise(() => start({ tool: box.tool, name: box.name!, exec: input?.exec }))
  return ok ? { ok: true } : { ok: false, error: `${box.tool} start ${box.name} failed` }
})
