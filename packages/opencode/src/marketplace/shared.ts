import path from "path"
import { fileURLToPath } from "url"
import { Filesystem } from "@/util/filesystem"
import { Marketplace } from "@opencode-ai/core/marketplace"

export type SourceKind = "github" | "url" | "path"

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
