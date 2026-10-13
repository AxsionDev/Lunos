#!/usr/bin/env bun
// XCOD-193: an update mirror for networks without internet access. On a machine that has it, this
// copies chosen Lunos releases' assets (offline bundles, archives, SBOM, SHA256SUMS and their
// Sigstore bundles) into a directory any web server or file share can serve inside the network:
//
//   <out>/v1.19.2/<asset>          every asset, checked against the release's SHA256SUMS
//   <out>/index.json               what is mirrored: releases, assets, sizes, SHA-256
//
// Nothing that doesn't match SHA256SUMS is kept. With --verify-signature (cosign on PATH), the
// SHA256SUMS signature is checked first, against this repository's publish workflow identity; the
// offline bundles' INSTALL-OFFLINE.md repeats that check on the offline side. Running it again
// downloads only what's missing. See docs/lts.md, "Offline update mirror".
//
//   bun script/release-mirror.ts --out /srv/lunos-mirror [--repo AxsionDev/Lunos]
//       [--pattern 'lunos-offline-*'] [--verify-signature] v1.19.2 [v1.19.3 …]

import { $ } from "bun"
import { mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises"
import path from "path"
import { BUNDLE_SUFFIX, IDENTITY_REGEXP, OIDC_ISSUER, SUMS, sha256 } from "./release-checksums"

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface Asset {
  name: string
  size: number
  sha256: string
}

export interface MirroredRelease {
  tag: string
  publishedAt?: string
  assets: Asset[]
}

/** Shell-style `*` and `?` patterns; none means every asset. SHA256SUMS and its bundle always come. */
export function wanted(name: string, patterns: readonly string[]) {
  if (name === SUMS || name === SUMS + BUNDLE_SUFFIX) return true
  if (!patterns.length) return true
  return patterns.some((p) =>
    new RegExp(
      `^${p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    ).test(name),
  )
}

/** `<hash>  <name>` lines (sha256sum format) → name → hash. */
export function parseSums(text: string) {
  const sums = new Map<string, string>()
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())
    if (m) sums.set(m[2]!, m[1]!)
  }
  return sums
}

const SAFE_NAME = /^[A-Za-z0-9._+-]{1,200}$/
const SAFE_TAG = /^v?\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$/

export class MirrorError extends Error {}

async function download(fetcher: Fetcher, url: string, file: string, headers: Record<string, string>) {
  const response = await fetcher(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok || !response.body) throw new MirrorError(`${url}: ${response.status}`)
  await Bun.write(`${file}.part`, response)
  await rename(`${file}.part`, file)
}

/** Mirrors one release into `<out>/<tag>/`; returns what is there, verified. */
export async function mirrorRelease(input: {
  repo: string
  tag: string
  out: string
  patterns?: readonly string[]
  fetcher?: Fetcher
  api?: string
  token?: string
  verifySignature?: (dir: string) => Promise<void>
  log?: (line: string) => void
}): Promise<MirroredRelease> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input.repo)) throw new MirrorError(`not a repository: ${input.repo}`)
  if (!SAFE_TAG.test(input.tag)) throw new MirrorError(`not a release tag: ${input.tag}`)
  const fetcher = input.fetcher ?? fetch
  const log = input.log ?? console.log
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
  }
  const api = input.api ?? "https://api.github.com"
  const r = await fetcher(`${api}/repos/${input.repo}/releases/tags/${input.tag}`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  })
  if (!r.ok) throw new MirrorError(`release ${input.tag}: ${r.status}`)
  const release = (await r.json()) as {
    tag_name: string
    published_at?: string
    draft?: boolean
    assets: Array<{ name: string; size: number; browser_download_url: string }>
  }
  if (release.draft) throw new MirrorError(`${input.tag} is a draft, not a published release`)
  const assets = release.assets.filter((a) => wanted(a.name, input.patterns ?? []))
  for (const a of assets)
    if (!SAFE_NAME.test(a.name)) throw new MirrorError(`unexpected asset name: ${JSON.stringify(a.name)}`)
  if (!assets.some((a) => a.name === SUMS))
    throw new MirrorError(`${input.tag} has no ${SUMS}: it can't be verified, so it isn't mirrored`)
  const dir = path.join(input.out, input.tag)
  await mkdir(dir, { recursive: true })
  const download$ = (a: (typeof assets)[number]) =>
    download(fetcher, a.browser_download_url, path.join(dir, a.name), { accept: "application/octet-stream" })

  // SHA256SUMS (and its signature) first, fresh every time: what everything else is checked against.
  for (const a of assets.filter((a) => a.name === SUMS || a.name === SUMS + BUNDLE_SUFFIX)) await download$(a)
  if (input.verifySignature) await input.verifySignature(dir)
  const sums = parseSums(await readFile(path.join(dir, SUMS), "utf8"))

  const out: Asset[] = []
  for (const a of assets) {
    if (a.name === SUMS || a.name.endsWith(BUNDLE_SUFFIX)) continue
    const expected = sums.get(a.name)
    if (!expected) throw new MirrorError(`${a.name} isn't in ${input.tag}'s ${SUMS}`)
    const file = path.join(dir, a.name)
    const have = await stat(file).catch(() => undefined)
    if (!have || (await sha256(file)) !== expected) {
      log(`downloading ${input.tag}/${a.name}`)
      await download$(a)
    }
    const got = await sha256(file)
    if (got !== expected) {
      await rm(file, { force: true })
      throw new MirrorError(`${input.tag}/${a.name} doesn't match ${SUMS} (got ${got}); removed`)
    }
    out.push({ name: a.name, size: (await stat(file)).size, sha256: got })
  }
  // Signature bundles of signed assets (the SBOM's) are kept as they are; cosign checks them.
  for (const a of assets.filter((a) => a.name.endsWith(BUNDLE_SUFFIX) && a.name !== SUMS + BUNDLE_SUFFIX))
    await download$(a)
  return { tag: input.tag, publishedAt: release.published_at, assets: out }
}

/** index.json: the mirrored releases, newest tag last, merged with what was already there. */
export async function writeIndex(out: string, repo: string, releases: MirroredRelease[]) {
  const file = path.join(out, "index.json")
  const existing = await readFile(file, "utf8")
    .then((t) => JSON.parse(t) as { releases: MirroredRelease[] })
    .catch(() => ({ releases: [] as MirroredRelease[] }))
  const byTag = new Map(existing.releases.map((r) => [r.tag, r]))
  for (const r of releases) byTag.set(r.tag, r)
  const sorted = [...byTag.values()].sort((a, b) => Bun.semver.order(a.tag.replace(/^v/, ""), b.tag.replace(/^v/, "")))
  await writeFile(
    file,
    JSON.stringify({ repo, generatedAt: new Date().toISOString(), releases: sorted }, null, 2) + "\n",
  )
  return sorted
}

async function cosignVerify(dir: string) {
  await $`cosign verify-blob --bundle ${SUMS + BUNDLE_SUFFIX} --certificate-identity-regexp ${IDENTITY_REGEXP} --certificate-oidc-issuer ${OIDC_ISSUER} ${SUMS}`.cwd(
    dir,
  )
}

async function main() {
  const args = process.argv.slice(2)
  const take = (flag: string) => {
    const i = args.indexOf(flag)
    if (i === -1) return undefined
    const [, value] = args.splice(i, 2)
    return value
  }
  const patterns: string[] = []
  for (let p = take("--pattern"); p; p = take("--pattern")) patterns.push(p)
  const out = take("--out")
  const repo = take("--repo") ?? "AxsionDev/Lunos"
  const verify = args.includes("--verify-signature")
  const tags = args.filter((a) => !a.startsWith("--"))
  if (!out || !tags.length)
    throw new Error(
      "usage: release-mirror.ts --out <dir> [--repo owner/name] [--pattern 'glob'] [--verify-signature] <tag>...",
    )
  const releases: MirroredRelease[] = []
  for (const tag of tags)
    releases.push(
      await mirrorRelease({
        repo,
        tag,
        out,
        patterns,
        token: process.env.GITHUB_TOKEN,
        verifySignature: verify ? cosignVerify : undefined,
      }),
    )
  const all = await writeIndex(out, repo, releases)
  console.log(
    `mirrored ${releases.map((r) => `${r.tag} (${r.assets.length} assets)`).join(", ")}; ${all.length} release(s) in ${path.join(out, "index.json")}`,
  )
}

if (import.meta.main) await main()
