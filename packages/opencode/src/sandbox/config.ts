import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { Schema } from "effect"
import { parse } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigSandbox } from "@opencode-ai/core/config/sandbox"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

// XCOD-144: the host reads only the `sandbox` key, straight from the config files. It deliberately
// does not go through the Config service: loading that bootstraps an instance, which initialises the
// project's plugins and installs `.opencode` dependencies on the host — exactly what a sandboxed run
// of an untrusted repo must not do. Precedence matches the full loader: global, then project files
// from the repo root down to the working directory, then OPENCODE_CONFIG_CONTENT.

export const IMAGE_REPOSITORY = "ghcr.io/axsiondev/lunos"
export const LOCAL_IMAGE = "lunos-sandbox:local"

export type Resolved = {
  enabled: boolean
  image: string
  workspace: "copy"
  on_finish: "destroy" | "retain"
  resources: { cpus: number; memory: string; pids: number; tmp: string }
}

const decode = Schema.decodeUnknownSync(ConfigSandbox.Info)

function read(file: string): ConfigSandbox.Info | undefined {
  if (!existsSync(file)) return undefined
  const data = parse(readFileSync(file, "utf8"), [], { allowTrailingComma: true })
  if (!data || typeof data !== "object" || !("sandbox" in data)) return undefined
  return decode((data as { sandbox: unknown }).sandbox)
}

function merge(base: ConfigSandbox.Info, next: ConfigSandbox.Info | undefined): ConfigSandbox.Info {
  if (!next) return base
  return { ...base, ...next, resources: { ...base.resources, ...next.resources } }
}

/** Files that can carry `sandbox`, lowest precedence first. */
export function files(directory: string, worktree: string) {
  const out = ["config.json", "opencode.json", "opencode.jsonc"].map((file) => path.join(Global.Path.config, file))
  if (Flag.OPENCODE_CONFIG) out.push(Flag.OPENCODE_CONFIG)
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

export * as SandboxConfig from "./config"
