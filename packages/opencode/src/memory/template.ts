export * as MemoryTemplate from "./template"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import { ConfigVariable } from "@/config/variable"

// XCOD-264: memory templates that run a database in Docker on this computer. Nothing is written
// before a preview, nothing existing is overwritten unless asked, the generated password goes only
// into a 0600 `.env` next to the compose file (never into lunos.json, which gets `{env:}`
// references), and `compose up` runs only when the user confirms it. The database is bound to
// 127.0.0.1 by the compose file itself.

export type Scope = "user" | "project"

export type Docker = NonNullable<MemoryStorage.Environment["docker"]>

/** `docker` or `podman`, with compose. Undefined when neither is installed. */
export async function detect(which: (name: string) => string | null = (name) => Bun.which(name)) {
  for (const tool of ["docker", "podman"] as const) {
    const bin = which(tool)
    if (!bin) continue
    const compose = await Bun.spawn([bin, "compose", "version"], { stdout: "ignore", stderr: "ignore" })
      .exited.then((code) => code === 0)
      .catch(() => false)
    return { tool, compose } satisfies Docker
  }
  return undefined
}

/** Where a template's files go: the Lunos config directory, or the project's `.opencode/memory/`. */
export function dir(scope: Scope, name: string, worktree: string) {
  return scope === "user"
    ? path.join(Global.Path.config, "memory", name)
    : path.join(worktree, ".opencode", "memory", name)
}

/** The compose project name: one per template, and per project for project scope. */
export function project(scope: Scope, name: string, worktree: string) {
  if (scope === "user") return `lunos-memory-${name}`
  const hash = crypto.createHash("sha256").update(worktree).digest("hex").slice(0, 8)
  return `lunos-memory-${name}-${hash}`
}

/** 24 random bytes as base64url: 32 characters, safe in a URL, an env file and a shell. */
export function password() {
  return crypto.randomBytes(24).toString("base64url")
}

export const MASK = "•••••••• (generated: 32 random characters, written only to this file)"

export type File = { name: string; path: string; content: string; mode?: number; exists: boolean }

export type Plan = {
  template: MemoryStorage.Template
  scope: Scope
  dir: string
  project: string
  files: File[]
  memory: Record<string, unknown>
  /** The command that starts it, as argv and as text to copy. */
  up: string[]
  command: string
}

export type Values = {
  port?: number
  localModel?: string
  vendor?: "neo4j" | "postgres"
  url?: string
  jurisdiction?: string
}

/**
 * Everything a template would write, without writing it. For a Docker template the `.env` holds
 * the password; `reveal: false` (the preview) shows it masked, so a preview never prints it.
 */
export async function plan(input: {
  template: MemoryStorage.Template
  scope: Scope
  worktree: string
  values?: Values
  docker?: Docker
  reveal?: boolean
  password?: string
}): Promise<Plan> {
  const { template, scope } = input
  const values = input.values ?? {}
  const memory = MemoryStorage.memoryOf(template, values)
  const target = dir(scope, template.name, input.worktree)
  const name = project(scope, template.name, input.worktree)
  if (!template.compose) return { template, scope, dir: target, project: name, files: [], memory, up: [], command: "" }
  const secret = input.reveal === false ? MASK : (input.password ?? password())
  const made = MemoryStorage.files(template, { password: secret, port: values.port, project: name })
  const files: Omit<File, "exists">[] = [
    { name: "docker-compose.yml", path: path.join(target, "docker-compose.yml"), content: made.compose },
    { name: ".env", path: path.join(target, ".env"), content: made.env, mode: 0o600 },
    { name: ".env.example", path: path.join(target, ".env.example"), content: made.example },
    // In a project, so the password is never committed.
    ...(scope === "project" ? [{ name: ".gitignore", path: path.join(target, ".gitignore"), content: ".env\n" }] : []),
  ]
  const exists = await Promise.all(
    files.map((file) =>
      fs.stat(file.path).then(
        () => true,
        () => false,
      ),
    ),
  )
  const tool = input.docker?.tool ?? "docker"
  const compose = path.join(target, "docker-compose.yml")
  const up = [tool, "compose", "-f", compose, "--env-file", path.join(target, ".env"), "-p", name, "up", "-d"]
  return {
    template,
    scope,
    dir: target,
    project: name,
    files: files.map((file, index) => ({ ...file, exists: exists[index] })),
    memory,
    up,
    command: up.map(quote).join(" "),
  }
}

function quote(arg: string) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

export class ExistsError extends Error {
  override name = "MemoryTemplateExists"
}

/**
 * Write a plan's files. An existing file is never overwritten unless it is named in `overwrite`;
 * the files are checked first, so either all are written or none.
 */
export async function write(input: Plan, overwrite: readonly string[] = []) {
  const blocked = input.files.filter((file) => file.exists && !overwrite.includes(file.name))
  if (blocked.length)
    throw new ExistsError(
      `${blocked.map((file) => file.path).join(", ")} already exist${blocked.length === 1 ? "s" : ""}; nothing was written. Choose to replace ${blocked.length === 1 ? "it" : "them"}, or move ${blocked.length === 1 ? "it" : "them"} away first`,
    )
  await fs.mkdir(input.dir, { recursive: true })
  for (const file of input.files) {
    await fs.writeFile(file.path, file.content, { mode: file.mode ?? 0o644 })
    // writeFile's mode applies only when it creates the file.
    if (file.mode) await fs.chmod(file.path, file.mode)
  }
  return input.files.map((file) => file.path)
}

/** A template directory's `.env`, for the check: the variables its `{env:}` references need. */
export async function env(target: string): Promise<Record<string, string>> {
  const text = await fs.readFile(path.join(target, ".env"), "utf8").catch(() => "")
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
  }
  return out
}

/** The memory block with `{env:}` / `{file:}` references filled, for connecting from the wizard. */
export async function resolve(memory: Record<string, unknown>, extra: Record<string, string> = {}) {
  const text = await ConfigVariable.substitute({
    type: "virtual",
    source: "memory setup",
    dir: process.cwd(),
    text: JSON.stringify(memory),
    env: extra,
    missing: "empty",
  })
  return JSON.parse(text) as Record<string, unknown>
}

export type Started = { ok: true; ms: number } | { ok: false; stage: "start" | "health"; message: string; fix?: string }

/**
 * `compose up -d`, then wait for the container's healthcheck, up to two minutes. Only ever called
 * after the user confirmed the exact command (`plan.command`).
 */
export async function start(
  input: Pick<Plan, "up" | "project" | "dir">,
  options: { timeoutMs?: number; onProgress?: (status: string, elapsedMs: number) => void } = {},
): Promise<Started> {
  const started = Date.now()
  const proc = Bun.spawn(input.up, { cwd: input.dir, stdout: "pipe", stderr: "pipe" })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0)
    return {
      ok: false,
      stage: "start",
      message: err.trim().split("\n").slice(-3).join(" ") || `${input.up[0]} compose exited with ${code}`,
      fix: /port is already allocated|address already in use/i.test(err)
        ? "Another program uses that port. Stop it, or change the port in the .env file."
        : /Cannot connect to the Docker daemon|daemon running/i.test(err)
          ? "Start Docker (or Podman), then try again."
          : undefined,
    }
  const tool = input.up[0]
  const timeout = options.timeoutMs ?? 120_000
  let status = "starting"
  while (Date.now() - started < timeout) {
    const ids = await run([tool, "compose", "-p", input.project, "ps", "-q"])
    const id = ids.trim().split("\n")[0]
    if (id) status = (await run([tool, "inspect", "-f", "{{.State.Health.Status}}", id])).trim() || "starting"
    options.onProgress?.(status, Date.now() - started)
    if (status === "healthy") return { ok: true, ms: Date.now() - started }
    if (status === "unhealthy") break
    await Bun.sleep(2000)
  }
  return {
    ok: false,
    stage: "health",
    message:
      status === "unhealthy"
        ? "The database started but its healthcheck failed"
        : `The database wasn't healthy after ${Math.round(timeout / 1000)} seconds (last status: ${status})`,
    fix: `See its logs with: ${tool} compose -p ${input.project} logs`,
  }
}

async function run(argv: string[]) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}
