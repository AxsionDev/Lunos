import path from "path"
import { fileURLToPath } from "url"
import { parse as parseJsonc } from "jsonc-parser"
import * as ConfigPaths from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
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

// Marketplace manifests are curated infrequently, so a day-long TTL keeps `list`/`search`/Discover
// cache-first (no network per read) while still self-healing without a background fiber — the same
// "refresh on a timer" v1 policy the ticket allows, applied lazily on read instead of on a schedule.
// Mirrors the disk-cache shape `@opencode-ai/core/models-dev` already uses: `Hash.fast(source)` under
// `Global.Path.cache`, freshness read from file mtime, not a bespoke format.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type MarketplaceCacheDeps = {
  dir: string
  mtime: (file: string) => Promise<number | undefined>
  readText: (file: string) => Promise<string | undefined>
  write: (file: string, text: string) => Promise<void>
}

function cacheFile(dir: string, source: string) {
  return path.join(dir, `${Hash.fast(source)}.json`)
}

export const defaultMarketplaceCacheDeps: MarketplaceCacheDeps = {
  dir: path.join(Global.Path.cache, "marketplace"),
  mtime: async (file) => {
    const stat = await Filesystem.statAsync(file)
    return stat ? Number(stat.mtimeMs) : undefined
  },
  readText: async (file) => ((await Filesystem.exists(file)) ? Filesystem.readText(file) : undefined),
  write: (file, text) => Filesystem.write(file, text),
}

// Reads a source's cached manifest plus how stale it is, without deciding whether to use it —
// callers combine this with a live fetch attempt per their own freshness/force policy.
async function readCachedManifest(source: string, dep: MarketplaceCacheDeps) {
  const file = cacheFile(dep.dir, source)
  const mtime = await dep.mtime(file)
  if (mtime === undefined) return undefined
  const text = await dep.readText(file)
  if (text === undefined) return undefined
  try {
    return { manifest: Marketplace.decode(JSON.parse(text)), fetchedAt: mtime }
  } catch {
    return undefined
  }
}

async function writeCachedManifest(source: string, manifest: Marketplace.Manifest, dep: MarketplaceCacheDeps) {
  await dep.write(cacheFile(dep.dir, source), JSON.stringify(manifest, null, 2))
}

// Seeds the cache with a manifest the caller already fetched and validated (used by
// `marketplace add`, which resolves the source live to validate it before persisting the config
// entry) so the very next `list`/`search`/Discover read is a cache hit instead of re-fetching the
// same source a second time.
export async function cacheMarketplaceManifest(
  source: string,
  manifest: Marketplace.Manifest,
  dep: MarketplaceCacheDeps = defaultMarketplaceCacheDeps,
) {
  await writeCachedManifest(source, manifest, dep)
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
  cache: MarketplaceCacheDeps
}

export const defaultMarketplaceListDeps: MarketplaceListDeps = {
  exists: (file) => Filesystem.exists(file),
  readText: (file) => Filesystem.readText(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  resolve: defaultFetchDeps,
  global: Global.Path.config,
  cache: defaultMarketplaceCacheDeps,
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

type ResolvedSource =
  | { source: string; ok: true; manifest: Marketplace.Manifest; fetchedAt: number; stale?: string }
  | { source: string; ok: false; error: string }

export type ResolvedMarketplace = ResolvedSource & { scope: "local" | "global" }

// Fetches live and refreshes the cache; on failure, falls back to whatever is cached (even if
// stale) so a source that's gone unreachable degrades to last-known-good instead of failing the
// whole caller. `force` skips the freshness check (used by the explicit `marketplace update` path);
// otherwise a cache hit within CACHE_TTL_MS is returned without any network/file-fetch call at all.
//
// Local `path` sources bypass the cache entirely and are always read live — mirroring
// `resolvePluginTarget` (packages/opencode/src/plugin/shared.ts), which caches npm installs but
// reads file-plugin paths straight off disk every time. A local directory/file has no network
// round-trip to save (the ticket's stated motivation for this cache) and can't go "unreachable but
// last-known-good" the way a URL or GitHub source can — it's just a file read.
async function resolveWithCache(source: string, dep: MarketplaceListDeps, force: boolean): Promise<ResolvedSource> {
  if (sourceKind(source) === "path") {
    return resolveMarketplaceManifest(source, dep.resolve).then(
      (manifest) => ({ source, ok: true as const, manifest, fetchedAt: Date.now() }),
      (error: unknown) => ({ source, ok: false as const, error: errorMessage(error) }),
    )
  }

  const cached = await readCachedManifest(source, dep.cache)
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { source, ok: true, manifest: cached.manifest, fetchedAt: cached.fetchedAt }
  }

  const fetched = await resolveMarketplaceManifest(source, dep.resolve).then(
    (item) => ({ ok: true as const, item }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  if (fetched.ok) {
    await writeCachedManifest(source, fetched.item, dep.cache)
    return { source, ok: true, manifest: fetched.item, fetchedAt: Date.now() }
  }

  const error = errorMessage(fetched.error)
  if (cached) return { source, ok: true, manifest: cached.manifest, fetchedAt: cached.fetchedAt, stale: error }
  return { source, ok: false, error }
}

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
      entries.push({ ...(await resolveWithCache(source, dep, false)), scope })
    }
  }
  return entries
}

export type RefreshMarketplaceResult =
  | { ok: true; manifest: Marketplace.Manifest; fetchedAt: number }
  | { ok: false; error: string; fetchedAt?: number }

// Forces a live re-fetch for one already-added source (`lunos marketplace update <name>`),
// bypassing the TTL. On failure the on-disk cache is left untouched, so `list`/`search`/Discover
// keep serving the prior last-known-good manifest (with `stale` set) rather than losing it.
export async function refreshMarketplaceCache(
  source: string,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<RefreshMarketplaceResult> {
  const resolved = await resolveWithCache(source, dep, true)
  if (resolved.ok && !resolved.stale) return { ok: true, manifest: resolved.manifest, fetchedAt: resolved.fetchedAt }
  if (resolved.ok) return { ok: false, error: resolved.stale!, fetchedAt: resolved.fetchedAt }
  return { ok: false, error: resolved.error }
}
