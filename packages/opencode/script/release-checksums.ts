#!/usr/bin/env bun
// XCOD-106: makes every release verifiable without a code-signing certificate.
//
// Runs in publish.yml after every asset is on the draft release and before it is published:
// downloads the assets, writes SHA256SUMS, and signs SHA256SUMS and the SBOM with Sigstore
// keyless signing (cosign + the workflow's GitHub OIDC token). The .sigstore.json bundles are
// uploaded next to them. A reviewer verifies the signature against this repository's workflow
// identity, then checks their download against SHA256SUMS. See docs/deployment/self-hosted.md.

import { $ } from "bun"
import { createHash } from "crypto"
import { createReadStream } from "fs"
import { mkdtemp, readdir } from "fs/promises"
import os from "os"
import path from "path"
import { REPOSITORY_URL } from "./package-meta"

export const SUMS = "SHA256SUMS"
export const BUNDLE_SUFFIX = ".sigstore.json"
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com"
/** The signer every Lunos release signature must carry: this repo's publish workflow, at any ref. */
export const IDENTITY_REGEXP = `^${REPOSITORY_URL.replaceAll(".", "\\.")}/\\.github/workflows/publish\\.yml@`

/** Everything on the release is checksummed except the checksum file and signature bundles. */
export function isChecksummed(name: string) {
  return name !== SUMS && !name.endsWith(BUNDLE_SUFFIX)
}

export function isSbom(name: string) {
  return /^lunos-sbom-.+\.cdx\.json$/.test(name)
}

/** `sha256sum` / `shasum -a 256` format, sorted by name so the file is reproducible. */
export function formatSums(entries: ReadonlyArray<{ name: string; hash: string }>) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => `${entry.hash}  ${entry.name}\n`)
    .join("")
}

export async function sha256(file: string) {
  const hash = createHash("sha256")
  // Streamed: desktop installers are hundreds of MB.
  await new Promise<void>((resolve, reject) =>
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject),
  )
  return hash.digest("hex")
}

export async function checksums(dir: string) {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isChecksummed(entry.name))
    .map((entry) => entry.name)
  return formatSums(await Promise.all(names.map(async (name) => ({ name, hash: await sha256(path.join(dir, name)) }))))
}

async function main() {
  const tag = process.argv[2]
  const repo = process.env.GH_REPO
  if (!tag || !repo) throw new Error("usage: GH_REPO=<owner/repo> release-checksums.ts <tag>")
  // Keyless signing needs the workflow's OIDC token (`id-token: write`). Without it a release
  // must not quietly ship unsigned while the docs tell reviewers to verify it.
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error("no GitHub OIDC token: cannot sign keylessly")

  const dir = await mkdtemp(path.join(os.tmpdir(), "lunos-release-"))
  await $`gh release download ${tag} --dir ${dir} --repo ${repo}`
  await Bun.write(path.join(dir, SUMS), await checksums(dir))

  const signed = [SUMS, ...(await readdir(dir)).filter(isSbom)]
  for (const name of signed) {
    await $`cosign sign-blob --yes --bundle ${name + BUNDLE_SUFFIX} ${name}`.cwd(dir)
    // Fail the release on a signature that doesn't verify against the identity the docs give.
    await $`cosign verify-blob --bundle ${name + BUNDLE_SUFFIX} --certificate-identity-regexp ${IDENTITY_REGEXP} --certificate-oidc-issuer ${OIDC_ISSUER} ${name}`.cwd(
      dir,
    )
  }
  const uploads = [SUMS, ...signed.map((name) => name + BUNDLE_SUFFIX)]
  await $`gh release upload ${tag} ${uploads} --clobber --repo ${repo}`.cwd(dir)
  console.log(`signed and uploaded: ${uploads.join(", ")}`)
}

if (import.meta.main) await main()
