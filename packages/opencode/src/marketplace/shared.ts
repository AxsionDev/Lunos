import path from "path"
import { fileURLToPath } from "url"
import { parse as parseJsonc } from "jsonc-parser"
import * as ConfigPaths from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { patchDir } from "../plugin/install"
import { errorMessage } from "../util/error"

export type SourceKind = "github" | "url" | "path"

// Config array field used to persist added marketplace sources, shared by the read side here
// (readSources/resolveAddedMarketplaces) and the write side in cli/cmd/marketplace.ts (which
// passes it to plugin/install.ts's generic patchPluginConfig as `field`).
export const FIELD = "marketplace"

const MANIFEST_FILE = "marketplace.json"
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+$/

export function isPathMarketplaceSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)
}

export function sourceKind(spec: string): SourceKind {
  if (spec.startsWith("http://") || spec.startsWith("https://")) return "url"
  if (isPathMarketplaceSpec(spec)) return "path"
  return "github"
}

// Path-like specs are normalized to an absolute path before being persisted, so a later `list` run
// (which may execute from a different cwd) resolves the same location `add` validated, mirroring why
// ConfigPlugin.resolvePluginSpec resolves path-like plugin specs eagerly instead of storing them raw.
export function normalizeSource(spec: string): string {
  if (sourceKind(spec) !== "path") return spec
  const raw = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  return path.isAbsolute(raw) ? raw : path.resolve(raw)
}

export type FetchDeps = {
  fetchText: (url: string) => Promise<string>
  readText: (file: string) => Promise<string>
  stat: (file: string) => Promise<{ isDirectory(): boolean } | undefined>
}

async function fetchText(url: string) {
  const response = await fetch(url, { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error(`Request to ${url} failed with status ${response.status}`)
  return response.text()
}

export const defaultFetchDeps: FetchDeps = {
  fetchText,
  readText: (file) => Filesystem.readText(file),
  stat: (file) => Filesystem.statAsync(file),
}

async function githubDefaultBranch(repo: string, dep: FetchDeps) {
  const text = await dep.fetchText(`https://api.github.com/repos/${repo}`)
  const data = JSON.parse(text) as { default_branch?: unknown }
  if (typeof data.default_branch !== "string" || !data.default_branch) {
    throw new Error(`Could not determine the default branch for ${repo}`)
  }
  return data.default_branch
}

async function manifestText(spec: string, kind: SourceKind, dep: FetchDeps) {
  if (kind === "url") return dep.fetchText(spec)
  if (kind === "github") {
    if (!GITHUB_SHORTHAND.test(spec)) throw new Error(`Invalid GitHub shorthand: ${spec}. Expected owner/repo`)
    const branch = await githubDefaultBranch(spec, dep)
    return dep.fetchText(`https://raw.githubusercontent.com/${spec}/${branch}/${MANIFEST_FILE}`)
  }
  const file = normalizeSource(spec)
  const stat = await dep.stat(file)
  const manifestPath = stat?.isDirectory() ? path.join(file, MANIFEST_FILE) : file
  return dep.readText(manifestPath)
}

export async function resolveMarketplaceManifest(spec: string, dep: FetchDeps = defaultFetchDeps) {
  const kind = sourceKind(spec)
  const text = await manifestText(spec, kind, dep)
  const json = JSON.parse(text)
  return Marketplace.decode(json)
}

export type MarketplaceCtx = {
  vcs?: string
  worktree: string
  directory: string
}

export type MarketplaceListDeps = {
  exists: (file: string) => Promise<boolean>
  readText: (file: string) => Promise<string>
  files: (dir: string, name: "opencode" | "tui") => string[]
  resolve: FetchDeps
  global: string
}

export const defaultMarketplaceListDeps: MarketplaceListDeps = {
  exists: (file) => Filesystem.exists(file),
  readText: (file) => Filesystem.readText(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  resolve: defaultFetchDeps,
  global: Global.Path.config,
}

async function readSources(dir: string, dep: MarketplaceListDeps) {
  const files = dep.files(dir, "opencode")
  for (const file of files) {
    if (!(await dep.exists(file))) continue
    const text = await dep.readText(file)
    const data = parseJsonc(text, [], { allowTrailingComma: true })
    if (!data || typeof data !== "object" || Array.isArray(data)) return []
    const list = (data as Record<string, unknown>)[FIELD]
    if (!Array.isArray(list)) return []
    return list.filter((item): item is string => typeof item === "string")
  }
  return []
}

export type ResolvedMarketplace =
  | { scope: "local" | "global"; source: string; ok: true; manifest: Marketplace.Manifest }
  | { scope: "local" | "global"; source: string; ok: false; error: string }

// Shared by the CLI's `marketplace list` (counts/names only), `plugin list`/`plugin search`
// (XCOD-11, full plugin rows), and the TUI's Discover view (XCOD-12) so all three read the same
// resolved manifests instead of parallel fetch paths.
export async function resolveAddedMarketplaces(
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<ResolvedMarketplace[]> {
  const localDir = patchDir({ spec: "", targets: [], vcs: ctx.vcs, worktree: ctx.worktree, directory: ctx.directory })
  const globalDir = patchDir({
    spec: "",
    targets: [],
    global: true,
    vcs: ctx.vcs,
    worktree: ctx.worktree,
    directory: ctx.directory,
    config: dep.global,
  })

  const scopes: Array<{ scope: "local" | "global"; dir: string }> = [
    { scope: "local", dir: localDir },
    { scope: "global", dir: globalDir },
  ]

  const entries: ResolvedMarketplace[] = []
  for (const { scope, dir } of scopes) {
    const sources = await readSources(dir, dep)
    for (const source of sources) {
      const resolved = await resolveMarketplaceManifest(source, dep.resolve).then(
        (item) => ({ ok: true as const, item }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      entries.push(
        resolved.ok
          ? { scope, source, ok: true, manifest: resolved.item }
          : { scope, source, ok: false, error: errorMessage(resolved.error) },
      )
    }
  }
  return entries
}
