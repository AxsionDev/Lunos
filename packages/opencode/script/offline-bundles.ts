#!/usr/bin/env bun
// XCOD-121: offline install bundles. One per CLI archive: lunos-offline-<os>-<arch>.tar.gz holds
// the archive, the model catalogue snapshot the binary was built with, the SBOM, INSTALL-OFFLINE.md,
// the release's signed SHA256SUMS and signatures, and Sigstore's trusted root, so an administrator
// can verify and install Lunos on a machine with no network.
//
// Runs in publish.yml after release-checksums.ts has written and signed SHA256SUMS: every file in a
// bundle except trusted_root.json is covered by that signature. The bundles themselves are listed
// in SHA256SUMS-offline, signed the same way, for checking a bundle before it is transferred.
//
//   GH_REPO=<owner/repo> bun offline-bundles.ts <tag>
//   bun offline-bundles.ts --local <dir>   (build bundles from release files already in <dir>)

import { $ } from "bun"
import { mkdtemp, mkdir, readdir, copyFile } from "fs/promises"
import os from "os"
import path from "path"
import { BUNDLE_SUFFIX, IDENTITY_REGEXP, OIDC_ISSUER, SUMS, formatSums, isSbom, sha256 } from "./release-checksums"

export const OFFLINE_SUMS = "SHA256SUMS-offline"
export const MODELS_SNAPSHOT = "lunos-models-snapshot.json"
export const INSTALL_DOC = "INSTALL-OFFLINE.md"
export const TRUSTED_ROOT = "trusted_root.json"

/** CLI archives on a release: lunos-linux-x64.tar.gz, lunos-darwin-arm64.zip, ... */
export function cliArchives(names: string[]) {
  return names.filter((name) => /^lunos-(linux|darwin|windows)-[a-z0-9-]+\.(tar\.gz|zip)$/.test(name)).sort()
}

export function bundleName(archive: string) {
  return archive.replace(/^lunos-/, "lunos-offline-").replace(/\.(tar\.gz|zip)$/, ".tar.gz")
}

/** What goes in a bundle, besides the archive itself. All but the trusted root are in SHA256SUMS. */
export function bundleFiles(names: string[]) {
  const sbom = names.find(isSbom)
  const required = [SUMS, SUMS + BUNDLE_SUFFIX, MODELS_SNAPSHOT, INSTALL_DOC]
  const missing = required.filter((name) => !names.includes(name))
  if (!sbom) missing.push("lunos-sbom-<version>.cdx.json")
  else if (!names.includes(sbom + BUNDLE_SUFFIX)) missing.push(sbom + BUNDLE_SUFFIX)
  if (missing.length) throw new Error(`offline bundles: release is missing ${missing.join(", ")}`)
  return [...required, sbom!, sbom! + BUNDLE_SUFFIX]
}

/** Every file a bundle carries must be checksummed by the signed SHA256SUMS (except the trust root). */
export function unsigned(sums: string, files: string[]) {
  const listed = new Set(
    sums
      .split("\n")
      .map((line) => line.split(/\s+/)[1])
      .filter(Boolean),
  )
  return files.filter((file) => file !== SUMS && !file.endsWith(BUNDLE_SUFFIX) && !listed.has(file))
}

/** Sigstore's public-good trust root: the first line of `gh attestation trusted-root`. */
async function trustedRoot(dir: string) {
  const lines = (await $`gh attestation trusted-root`.quiet().text()).split("\n").filter(Boolean)
  const root = lines
    .map((line) => JSON.parse(line))
    .find((entry) => JSON.stringify(entry).includes("rekor.sigstore.dev"))
  if (!root) throw new Error("offline bundles: no Sigstore public-good trusted root in `gh attestation trusted-root`")
  await Bun.write(path.join(dir, TRUSTED_ROOT), JSON.stringify(root))
}

export async function buildBundles(dir: string, out: string) {
  const names = await readdir(dir)
  const files = bundleFiles(names)
  const archives = cliArchives(names)
  if (!archives.length) throw new Error("offline bundles: no CLI archives on the release")
  const missing = unsigned(await Bun.file(path.join(dir, SUMS)).text(), [...files, ...archives])
  if (missing.length) throw new Error(`offline bundles: not covered by the signed ${SUMS}: ${missing.join(", ")}`)
  if (!names.includes(TRUSTED_ROOT)) await trustedRoot(dir)

  await mkdir(out, { recursive: true })
  const built: string[] = []
  for (const archive of archives) {
    const stage = await mkdtemp(path.join(os.tmpdir(), "lunos-offline-"))
    const name = bundleName(archive)
    const root = path.join(stage, name.replace(/\.tar\.gz$/, ""))
    await mkdir(root)
    for (const file of [archive, ...files, TRUSTED_ROOT]) await copyFile(path.join(dir, file), path.join(root, file))
    await $`tar --no-xattrs -czf ${path.join(out, name)} -C ${stage} ${path.basename(root)}`
    built.push(name)
  }
  const sums = formatSums(
    await Promise.all(built.map(async (name) => ({ name, hash: await sha256(path.join(out, name)) }))),
  )
  await Bun.write(path.join(out, OFFLINE_SUMS), sums)
  return built
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === "--local") {
    const built = await buildBundles(args[1], path.join(args[1], "offline"))
    console.log(`built ${built.length} offline bundles in ${path.join(args[1], "offline")}`)
    return
  }
  const tag = args[0]
  const repo = process.env.GH_REPO
  if (!tag || !repo) throw new Error("usage: GH_REPO=<owner/repo> offline-bundles.ts <tag>")
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error("no GitHub OIDC token: cannot sign keylessly")

  const dir = await mkdtemp(path.join(os.tmpdir(), "lunos-release-"))
  await $`gh release download ${tag} --dir ${dir} --repo ${repo} --pattern ${"lunos-*"} --pattern ${"SHA256SUMS*"} --pattern ${MODELS_SNAPSHOT} --pattern ${INSTALL_DOC}`
  const out = path.join(dir, "offline")
  const built = await buildBundles(dir, out)
  await $`cosign sign-blob --yes --bundle ${OFFLINE_SUMS + BUNDLE_SUFFIX} ${OFFLINE_SUMS}`.cwd(out)
  await $`cosign verify-blob --bundle ${OFFLINE_SUMS + BUNDLE_SUFFIX} --certificate-identity-regexp ${IDENTITY_REGEXP} --certificate-oidc-issuer ${OIDC_ISSUER} ${OFFLINE_SUMS}`.cwd(
    out,
  )
  const uploads = [...built, OFFLINE_SUMS, OFFLINE_SUMS + BUNDLE_SUFFIX]
  await $`gh release upload ${tag} ${uploads} --clobber --repo ${repo}`.cwd(out)
  console.log(`uploaded ${built.length} offline bundles and ${OFFLINE_SUMS}`)
}

if (import.meta.main) await main()
