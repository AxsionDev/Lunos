import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { Schema } from "effect"
import { parse } from "jsonc-parser"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigSandbox } from "@opencode-ai/core/config/sandbox"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ConfigManaged } from "@/config/managed"

// XCOD-144: the host reads only the `sandbox` key, straight from the config files. It deliberately
// does not go through the Config service: loading that bootstraps an instance, which initialises the
// project's plugins and installs `.opencode` dependencies on the host — exactly what a sandboxed run
// of an untrusted repo must not do. Precedence matches the full loader: global, then project files
// from the repo root down to the working directory, then OPENCODE_CONFIG_CONTENT.
//
// XCOD-157: it also reads the user's global config and the organisation's managed config, raw, to
// carry them into the container (neither is in the copied repo, so without this a residency policy
// set globally or locked by the organisation silently didn't apply inside a sandbox), and to
// activate the host's audit trail for the sandbox's own events.

export const IMAGE_REPOSITORY = "ghcr.io/axsiondev/lunos"
export const LOCAL_IMAGE = "lunos-sandbox:local"

export type Resolved = {
  enabled: boolean
  image: string
  workspace: "copy"
  on_finish: "destroy" | "retain" | "destroy_on_success"
  /** How long a retained sandbox is kept, in milliseconds; undefined keeps it until destroyed. */
  retain_for?: number
  resources: { cpus: number; memory: string; pids: number; tmp: string }
}

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** "72h", "30m", "7d" in milliseconds. The schema has already checked the shape. */
export function duration(value: string) {
  const unit = value.at(-1) as keyof typeof UNIT
  return Number(value.slice(0, -1)) * UNIT[unit]
}

const decode = Schema.decodeUnknownSync(ConfigSandbox.Info)

type Doc = Record<string, unknown>

const isDoc = (value: unknown): value is Doc => !!value && typeof value === "object" && !Array.isArray(value)

function readDoc(file: string): Doc | undefined {
  if (!existsSync(file)) return undefined
  const data = parse(readFileSync(file, "utf8"), [], { allowTrailingComma: true })
  return isDoc(data) ? data : undefined
}

function read(file: string): ConfigSandbox.Info | undefined {
  const data = readDoc(file)
  if (!data || !("sandbox" in data)) return undefined
  return decode(data.sandbox)
}

function merge(base: ConfigSandbox.Info, next: ConfigSandbox.Info | undefined): ConfigSandbox.Info {
  if (!next) return base
  return { ...base, ...next, resources: { ...base.resources, ...next.resources } }
}

/** The user's own config files, lowest precedence first: global, then OPENCODE_CONFIG. */
export function globalFiles() {
  const out = ["config.json", "opencode.json", "opencode.jsonc"].map((file) => path.join(Global.Path.config, file))
  if (Flag.OPENCODE_CONFIG) out.push(Flag.OPENCODE_CONFIG)
  return out
}

/** Files that can carry `sandbox`, lowest precedence first. */
export function files(directory: string, worktree: string) {
  const out = globalFiles()
  if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return out
  const dirs: string[] = []
  for (let dir = directory; ; dir = path.dirname(dir)) {
    dirs.unshift(dir)
    if (dir === worktree || path.dirname(dir) === dir) break
  }
  for (const dir of dirs)
    out.push(
      path.join(dir, "opencode.json"),
      path.join(dir, "opencode.jsonc"),
      path.join(dir, ".opencode", "opencode.json"),
      path.join(dir, ".opencode", "opencode.jsonc"),
    )
  return out
}

/** The default image: the published one for a released CLI, the locally built one otherwise. */
export function defaultImage(version = InstallationVersion) {
  return /^\d+\.\d+\.\d+$/.test(version) ? `${IMAGE_REPOSITORY}:${version}` : LOCAL_IMAGE
}

export function resolve(info: ConfigSandbox.Info): Resolved {
  return {
    enabled: info.enabled ?? false,
    image: info.image ?? defaultImage(),
    workspace: info.workspace ?? "copy",
    on_finish: info.on_finish ?? "destroy",
    retain_for: info.retain_for ? duration(info.retain_for) : undefined,
    resources: {
      cpus: info.resources?.cpus ?? 2,
      memory: info.resources?.memory ?? "4g",
      pids: info.resources?.pids ?? 512,
      tmp: info.resources?.tmp ?? "1g",
    },
  }
}

/** The enclosing repository's top (the nearest directory with a .git entry), else the directory. */
export function worktreeOf(directory: string) {
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) return path.resolve(directory)
  }
}

export function load(directory: string, worktree = worktreeOf(directory)): Resolved {
  const layers = files(directory, worktree).map(read)
  const content = Flag.OPENCODE_CONFIG_CONTENT
  if (content) {
    const data = parse(content, [], { allowTrailingComma: true }) as { sandbox?: unknown } | undefined
    if (data?.sandbox) layers.push(decode(data.sandbox))
  }
  const info = layers.reduce<ConfigSandbox.Info>(merge, {})
  // `enabled` is the one key that isn't last-wins: a repository's own config must not be able to
  // switch off a sandbox the user asked for, and so run itself (and its plugins) on the host.
  // Only --no-sandbox turns it off for a run.
  return resolve({ ...info, enabled: layers.some((layer) => layer?.enabled === true) })
}

/**
 * Merge config documents the way the loader does: deep, later wins, `instructions` unioned. The
 * managed documents' `$locked` lists are unioned too, so merging them loses no lock.
 */
export function mergeDocs(docs: readonly unknown[]): Doc {
  return docs.filter(isDoc).reduce<Doc>((acc, doc) => {
    const merged = mergeDeep(acc, doc) as Doc
    for (const key of ["instructions", "$locked"])
      if (Array.isArray(acc[key]) && Array.isArray(doc[key]))
        merged[key] = Array.from(new Set([...(acc[key] as unknown[]), ...(doc[key] as unknown[])]))
    return merged
  }, {})
}

/** The user's global config, merged: what the container gets as its OPENCODE_CONFIG. */
export function globalDoc(): Doc {
  return mergeDocs(globalFiles().map(readDoc))
}

/**
 * The organisation's managed config, merged in precedence order (the system directory, then on
 * macOS the MDM profile), or undefined when there is none. The container gets it read-only, at the
 * path Lunos reads managed config from on Linux, so its `$locked` keys hold inside the sandbox.
 */
export async function managedDoc(): Promise<Doc | undefined> {
  const docs = await ConfigManaged.readManagedDocs()
  return docs.some(isDoc) ? mergeDocs(docs) : undefined
}

/**
 * The host's audit settings for the sandbox's own events, from global and managed config. The
 * repository's config is deliberately not consulted: it's the code being sandboxed, and must not
 * choose where the host writes its audit trail. A managed `$locked` audit or residency block wins.
 */
export function auditConfig(global: Doc, managed: Doc | undefined) {
  const pick = (key: "audit" | "residency") => {
    const locked = Array.isArray(managed?.$locked) && (managed.$locked as unknown[]).includes(key)
    if (locked) return managed?.[key]
    return mergeDocs([global[key], managed?.[key]].map((value) => (isDoc(value) ? { value } : {}))).value
  }
  return { audit: pick("audit"), residency: pick("residency") } as {
    audit?: { enabled?: boolean; path?: string; redact?: string[] }
    residency?: { allow: string[]; audit?: boolean; auditPath?: string }
  }
}

export * as SandboxConfig from "./config"
