// XCOD-121: third-party tools shipped in the offline bundles, so an air-gapped machine doesn't have
// to source them separately. ripgrep is what Lunos's search tools run (and would otherwise
// download on first use, which LUNOS_OFFLINE forbids); cosign re-verifies the release signatures
// on the offline machine.
//
// Versions and SHA-256 hashes are pinned here, copied from each project's release checksums. A
// download that doesn't match its pin fails the release, rather than shipping something unchecked.
// RIPGREP_VERSION must match the version packages/core/src/ripgrep/binary.ts downloads (a test
// checks this).

import { $ } from "bun"
import { mkdir, mkdtemp, copyFile, chmod } from "fs/promises"
import os from "os"
import path from "path"
import { sha256 } from "../release-checksums"

export const RIPGREP_VERSION = "15.1.0"
export const COSIGN_VERSION = "v3.1.3"
export const TOOLS_DIR = "tools"
export const TOOLS_DOC = "TOOLS.txt"

type Download = { url: string; sha256: string }
/** A ripgrep release archive: `rg` is at `ripgrep-<version>-<target>/rg[.exe]` inside it. */
type Ripgrep = Download & { target: string }

const RIPGREP_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`
const ripgrep = (target: string, extension: string, hash: string): Ripgrep => ({
  target,
  url: `${RIPGREP_BASE}/ripgrep-${RIPGREP_VERSION}-${target}.${extension}`,
  sha256: hash,
})
const COSIGN_BASE = `https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}`
const cosign = (file: string, hash: string): Download => ({ url: `${COSIGN_BASE}/${file}`, sha256: hash })

const RIPGREP = {
  "darwin-arm64": ripgrep(
    "aarch64-apple-darwin",
    "tar.gz",
    "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  ),
  "darwin-x64": ripgrep(
    "x86_64-apple-darwin",
    "tar.gz",
    "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
  ),
  "linux-arm64": ripgrep(
    "aarch64-unknown-linux-gnu",
    "tar.gz",
    "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
  ),
  // Statically linked, so it runs on glibc and musl systems alike.
  "linux-x64": ripgrep(
    "x86_64-unknown-linux-musl",
    "tar.gz",
    "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
  ),
  "windows-arm64": ripgrep(
    "aarch64-pc-windows-msvc",
    "zip",
    "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
  ),
  "windows-x64": ripgrep(
    "x86_64-pc-windows-msvc",
    "zip",
    "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
  ),
}

const COSIGN = {
  "darwin-arm64": cosign("cosign-darwin-arm64", "5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76"),
  "darwin-x64": cosign("cosign-darwin-amd64", "2347488e5d5b25336644024dfeca5601b190e91197a71a917bda44744aff106c"),
  "linux-arm64": cosign("cosign-linux-arm64", "c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a"),
  "linux-x64": cosign("cosign-linux-amd64", "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71"),
  // cosign has no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
  "windows-arm64": cosign(
    "cosign-windows-amd64.exe",
    "9fe59be0eca1271873ce019061335eb1ac419b7059202e797828467ddabe33be",
  ),
  "windows-x64": cosign("cosign-windows-amd64.exe", "9fe59be0eca1271873ce019061335eb1ac419b7059202e797828467ddabe33be"),
}

type Platform = keyof typeof COSIGN

/**
 * The tools for a CLI archive's platform. `-baseline` builds run the same tools. ripgrep has no
 * arm64 musl build, so the linux-arm64-musl bundle has no `rg`: install it from the OS packages
 * (`apk add ripgrep`).
 */
export function toolsFor(archive: string) {
  const match = archive.match(/^lunos-(linux|darwin|windows)-(x64|arm64)(-baseline)?(-musl)?\./)
  if (!match) throw new Error(`offline bundles: no tools for ${archive}`)
  const platform = `${match[1]}-${match[2]}` as Platform
  const exe = match[1] === "windows" ? ".exe" : ""
  const musl = Boolean(match[4])
  return {
    cosign: { name: `cosign${exe}`, ...COSIGN[platform] },
    rg: musl && match[2] === "arm64" ? undefined : { name: `rg${exe}`, ...RIPGREP[platform] },
  }
}

async function download(item: Download, cache: string) {
  const file = path.join(cache, path.basename(item.url))
  if (!(await Bun.file(file).exists())) {
    const response = await fetch(item.url)
    if (!response.ok) throw new Error(`offline bundles: ${item.url} returned ${response.status}`)
    await Bun.write(file, response)
  }
  const hash = await sha256(file)
  if (hash !== item.sha256) throw new Error(`offline bundles: ${item.url} has SHA-256 ${hash}, pinned ${item.sha256}`)
  return file
}

/** Downloads, checks and unpacks the tools for `archive` into `<root>/tools/`, and describes them in TOOLS.txt. */
export async function addTools(archive: string, root: string, cache: string) {
  const tools = toolsFor(archive)
  const dir = path.join(root, TOOLS_DIR)
  await mkdir(dir, { recursive: true })
  const lines = [
    "Third-party tools in this bundle. Each was downloaded from the URL below and checked against",
    "the SHA-256 pinned in Lunos's release script before it was packed; the bundle as a whole is",
    "covered by the signed SHA256SUMS-offline.",
    "",
  ]

  const cosignFile = await download(tools.cosign, cache)
  await copyFile(cosignFile, path.join(dir, tools.cosign.name))
  await chmod(path.join(dir, tools.cosign.name), 0o755)
  lines.push(`${TOOLS_DIR}/${tools.cosign.name}  cosign ${COSIGN_VERSION} (Apache-2.0)`)
  lines.push(`  from ${tools.cosign.url}`, `  sha256 ${tools.cosign.sha256}`, "")

  if (tools.rg) {
    const archiveFile = await download(tools.rg, cache)
    const unpack = await mkdtemp(path.join(os.tmpdir(), "lunos-rg-"))
    if (archiveFile.endsWith(".zip")) await $`unzip -q ${archiveFile} -d ${unpack}`
    else await $`tar -xzf ${archiveFile} -C ${unpack}`
    await copyFile(
      path.join(unpack, `ripgrep-${RIPGREP_VERSION}-${tools.rg.target}`, tools.rg.name),
      path.join(dir, tools.rg.name),
    )
    await chmod(path.join(dir, tools.rg.name), 0o755)
    lines.push(`${TOOLS_DIR}/${tools.rg.name}  ripgrep ${RIPGREP_VERSION} (MIT or Unlicense), unpacked from`)
    lines.push(`  ${tools.rg.url}`, `  sha256 ${tools.rg.sha256} (of that archive)`, "")
  } else {
    lines.push("No ripgrep: there is no ripgrep build for this platform. Install it from your OS packages.", "")
  }
  await Bun.write(path.join(root, TOOLS_DOC), lines.join("\n"))
}
