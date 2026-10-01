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
import { SandboxDocker } from "./docker"

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
  /** sandbox.required: nothing may run on the host. Implies `enabled`. */
  required: boolean
  /** Where `required` came from, for the refusal message. */
  requiredBy?: "managed" | "config"
  image: string
  /**
   * XCOD-158: "mount" bind-mounts your working tree. From your global and managed config only, and
   * under a managed sandbox.required only if managed config itself chose it.
   */
  workspace: "copy" | "mount"
  /** Extra read-only mounts, from your global and managed config only. */
  mounts: { source: string; target: string }[]
  results: "branch" | "patch" | "none"
  runtime?: "docker" | "podman"
  on_finish: "destroy" | "retain" | "destroy_on_success"
  /** How long a retained sandbox is kept, in milliseconds; undefined keeps it until destroyed. */
  retain_for?: number
  network: Network
  /** sandbox.allow, from user and managed config only: extra "host:port" entries for the egress proxy. */
  allow: string[]
  /**
   * The image the egress proxy runs: sandbox.image when your global or managed config set it (a
   * mirror, for machines without ghcr.io), else the default. Never a repository's choice.
   */
  egressImage: string
  resources: { cpus: number; memory: string; pids: number; tmp: string }
}

export type Network = "policy" | "none" | "open"

/** Stricter modes win when a repository's config and yours disagree. */
const STRICTNESS: Record<Network, number> = { open: 0, policy: 1, none: 2 }
export const strictest = (...modes: (Network | undefined)[]) =>
  modes
    .filter((mode): mode is Network => !!mode)
    .reduce<
      Network | undefined
    >((acc, mode) => (acc === undefined || STRICTNESS[mode] > STRICTNESS[acc] ? mode : acc), undefined)

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
    required: info.required ?? false,
    image: info.image ?? defaultImage(),
    workspace: info.workspace ?? "copy",
    mounts: (info.mounts ?? []).map((item) => ({ source: item.source, target: item.target ?? item.source })),
    results: info.results ?? "branch",
    runtime: info.runtime,
    on_finish: info.on_finish ?? "destroy",
    retain_for: info.retain_for ? duration(info.retain_for) : undefined,
    network: info.network ?? "policy",
    allow: info.allow ?? [],
    egressImage: defaultImage(),
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
  const all = files(directory, worktree)
  const user = all.slice(0, globalFiles().length).map(read)
  const project = all.slice(globalFiles().length).map(read)
  const content = Flag.OPENCODE_CONFIG_CONTENT
  if (content) {
    const data = parse(content, [], { allowTrailingComma: true }) as { sandbox?: unknown } | undefined
    if (data?.sandbox) user.push(decode(data.sandbox))
  }
  // XCOD-157: managed config last, so the organisation's settings win.
  const managed = mergeDocs(ConfigManaged.readManagedDocsSync())
  const managedLayer = isDoc(managed.sandbox) ? decode(managed.sandbox) : undefined
  const layers = [...user.slice(0, globalFiles().length), ...project, ...user.slice(globalFiles().length), managedLayer]
  const info = layers.reduce<ConfigSandbox.Info>(merge, {})
  // The network and its allow list are yours and your organisation's to open: a repository can make
  // the network stricter, never looser, and can't add hosts to it.
  const mine = [...user, managedLayer]
  const network = strictest(
    mine.reduce<Network | undefined>((acc, layer) => layer?.network ?? acc, undefined) ?? "policy",
    strictest(...project.map((layer) => layer?.network)),
  )
  const allow = Array.from(new Set(mine.flatMap((layer) => layer?.allow ?? [])))
  const egressImage = mine.reduce<string | undefined>((acc, layer) => layer?.image ?? acc, undefined) ?? defaultImage()
  // XCOD-158: a bind mount weakens the isolation, so it's yours or your organisation's to choose, as
  // the network is; a repository can't. When the organisation requires sandboxes, only its own
  // managed config can choose it: your opting in doesn't weaken what it required.
  const managedRequired = managedLayer?.required === true
  const workspace = managedRequired
    ? (managedLayer?.workspace ?? "copy")
    : (mine.reduce<ConfigSandbox.Info["workspace"]>((acc, layer) => layer?.workspace ?? acc, undefined) ?? "copy")
  const mounts = mine.flatMap((layer) => layer?.mounts ?? [])
  // `enabled` and `required` aren't last-wins: a repository's own config must not be able to switch
  // off a sandbox the user or the organisation asked for, and so run itself (and its plugins) on the
  // host. Only --no-sandbox turns `enabled` off for a run, and nothing turns `required` off.
  const requiredBy =
    managedLayer?.required === true
      ? "managed"
      : layers.some((layer) => layer?.required === true)
        ? "config"
        : undefined
  const enabled = !!requiredBy || layers.some((layer) => layer?.enabled === true)
  return {
    ...resolve({ ...info, enabled, required: !!requiredBy, network, allow, workspace, mounts }),
    egressImage,
    requiredBy,
  }
}

/**
 * Everything the egress allow list is derived from, merged the way the server inside will see it:
 * global, then project, then OPENCODE_CONFIG_CONTENT, then managed, with managed `$locked` keys
 * holding exactly the managed value.
 */
export function effectiveDoc(directory: string, managed: Doc | undefined, worktree = worktreeOf(directory)): Doc {
  const docs: unknown[] = files(directory, worktree).map(readDoc)
  if (Flag.OPENCODE_CONFIG_CONTENT) docs.push(parse(Flag.OPENCODE_CONFIG_CONTENT, [], { allowTrailingComma: true }))
  const merged = mergeDocs([...docs, managed])
  const locked = Array.isArray(managed?.$locked) ? (managed.$locked as unknown[]) : []
  for (const key of locked) if (typeof key === "string" && !key.includes(".")) merged[key] = managed?.[key]
  return merged
}

/**
 * Whether this process is the server inside a sandbox. LUNOS_SANDBOX alone isn't proof: anyone can
 * set it on the host. The marker is in the policy volume, root-owned at /etc/lunos, which a user
 * can't create on the host without administrator rights.
 */
export function inside(
  env = process.env.LUNOS_SANDBOX,
  marker = path.join(SandboxDocker.POLICY_DIR, SandboxDocker.MARKER),
) {
  if (!env || !existsSync(marker)) return false
  try {
    return (JSON.parse(readFileSync(marker, "utf8")) as { id?: string }).id === env
  } catch {
    return false
  }
}

/** Why the host must not run this, or undefined when it may. */
export function refusal(config: Pick<Resolved, "required" | "requiredBy">, what: string, isInside = inside()) {
  if (!config.required || isInside) return undefined
  const by =
    config.requiredBy === "managed"
      ? " by your organisation's managed config"
      : config.requiredBy === "config"
        ? " in your config"
        : ""
  return (
    `sandbox.required is set${by}, so ${what} can't run on this machine; nothing may run outside a sandbox. ` +
    "Use `lunos --sandbox` or `lunos run --sandbox` (both are sandboxed automatically), or ask your administrator."
  )
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
