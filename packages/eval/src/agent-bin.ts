// XCOD-200: the Lunos binary and ripgrep the agent puts into each task container, prepared once on
// the host. Installing in the container (apt nodejs npm, then `npm i -g lunos-ai`) failed: the
// Polyglot images are Ubuntu 22.04, whose Node 12 / npm 8 can't install lunos-ai, and apt alone
// took ~110 s of Harbor's 360 s agent-setup limit.
//
// The release archive is checked against the release's SHA256SUMS, and ripgrep against the hash
// pinned for the offline bundles (packages/opencode/script/offline/tools.ts). Every task image is
// glibc-based, so the glibc builds are used.

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { download, RIPGREP_VERSION, toolsFor } from "../../opencode/script/offline/tools"
import { sha256 } from "../../opencode/script/release-checksums"

const RELEASES = "https://github.com/AxsionDev/Lunos/releases/download"

/** Docker's architecture name to the release's. */
export function releaseArch(dockerArch: string) {
  if (dockerArch === "aarch64" || dockerArch === "arm64") return "arm64"
  if (dockerArch === "x86_64" || dockerArch === "amd64") return "x64"
  throw new Error(`eval: no Lunos build for container architecture ${dockerArch}`)
}

/** The SHA-256 a SHA256SUMS file lists for `name`. */
export function listedHash(sums: string, name: string) {
  for (const line of sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+\*?/)
    if (file === name) return hash
  }
}

/** `<dir>/lunos` and `<dir>/rg` for the containers' architecture, downloaded and verified once. */
export async function agentBinaries(version: string, cache: string) {
  const arch = releaseArch((await $`docker info --format {{.Architecture}}`.text()).trim())
  const archive = `lunos-linux-${arch}.tar.gz`
  const dir = path.join(cache, `lunos-${version}-linux-${arch}`)
  const lunos = path.join(dir, "lunos")
  const rg = path.join(dir, "rg")
  if ((await Bun.file(lunos).exists()) && (await Bun.file(rg).exists())) return { dir, lunos, rg }
  await fs.mkdir(dir, { recursive: true })

  const sums = await (await fetch(`${RELEASES}/v${version}/SHA256SUMS`)).text()
  const expected = listedHash(sums, archive)
  if (!expected) throw new Error(`eval: ${archive} is not in v${version}'s SHA256SUMS`)
  const file = await download({ url: `${RELEASES}/v${version}/${archive}`, sha256: expected }, cache)
  await $`tar -xzf ${file} -C ${dir} opencode`
  await fs.rename(path.join(dir, "opencode"), lunos)

  const tool = toolsFor(archive).rg!
  const rgArchive = await download(tool, cache)
  await $`tar -xzf ${rgArchive} -C ${dir} ripgrep-${RIPGREP_VERSION}-${tool.target}/rg`
  await fs.rename(path.join(dir, `ripgrep-${RIPGREP_VERSION}-${tool.target}`, "rg"), rg)
  await fs.rm(path.join(dir, `ripgrep-${RIPGREP_VERSION}-${tool.target}`), { recursive: true })

  console.log(
    `agent binaries: Lunos ${version} (sha256 ${await sha256(file)}) and ripgrep ${RIPGREP_VERSION}, linux-${arch}`,
  )
  return { dir, lunos, rg }
}
