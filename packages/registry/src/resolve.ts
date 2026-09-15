import { Marketplace } from "@opencode-ai/core/marketplace"
import type { ManifestJson } from "./db"

/**
 * XCOD-35's `resolve`: re-fetches one registered source's manifest over the network.
 *
 * Deliberately a Worker-safe REIMPLEMENTATION of the CLI's `resolveMarketplaceManifest`
 * (packages/opencode/src/marketplace/shared.ts), not a shared import of it — that module
 * pulls in `fs`/`Filesystem` and a disk cache built for the CLI's local-machine
 * environment, neither of which exists inside a Cloudflare Worker. It also only
 * implements the CLI's `"path"` source kind for local filesystem sources, which has no
 * meaning for a hosted registry re-fetching on a schedule (there is no local disk to read
 * from), so that kind is intentionally NOT reproduced here — only the two kinds that are
 * actually re-fetchable over the network: a direct manifest URL, or a bare GitHub
 * "owner/repo" shorthand.
 */

const MANIFEST_FILE = "marketplace.json"
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+$/

function isGithubShorthand(source: string): boolean {
  return !source.startsWith("http://") && !source.startsWith("https://") && GITHUB_SHORTHAND.test(source)
}

export type ResolveDeps = {
  readonly fetchText: (url: string) => Promise<string>
}

/**
 * `User-Agent` is NOT optional here the way it might look: GitHub's REST API (the
 * `githubDefaultBranch` call below) rejects unauthenticated requests that omit it with a
 * 403, and unlike Bun/Node's `fetch`, Cloudflare Workers' `fetch` does not supply one on
 * its own. Set on every request, not just the GitHub-API one, so this stays one code path.
 */
async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "lunos-registry-ingestion" },
  })
  if (!response.ok) throw new Error(`Request to ${url} failed with status ${response.status}`)
  return response.text()
}

export const defaultResolveDeps: ResolveDeps = { fetchText: defaultFetchText }

async function githubDefaultBranch(repo: string, dep: ResolveDeps): Promise<string> {
  const text = await dep.fetchText(`https://api.github.com/repos/${repo}`)
  const data = JSON.parse(text) as { default_branch?: unknown }
  if (typeof data.default_branch !== "string" || !data.default_branch) {
    throw new Error(`Could not determine the default branch for ${repo}`)
  }
  return data.default_branch
}

async function manifestText(source: string, dep: ResolveDeps): Promise<string> {
  if (!isGithubShorthand(source)) return dep.fetchText(source)
  const branch = await githubDefaultBranch(source, dep)
  return dep.fetchText(`https://raw.githubusercontent.com/${source}/${branch}/${MANIFEST_FILE}`)
}

/**
 * Fetches and schema-validates one source's manifest. Throws on any failure — network,
 * HTTP status, malformed JSON, or a `Marketplace.decode` schema violation — which
 * `runIngestion` (ingest.ts) catches per-source, so one bad source never aborts the run
 * or corrupts that source's last-known-good data (XCOD-35 AC2).
 */
export async function resolveSource(source: string, dep: ResolveDeps = defaultResolveDeps): Promise<ManifestJson> {
  const text = await manifestText(source, dep)
  return Marketplace.decode(JSON.parse(text))
}
