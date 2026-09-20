#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

// Published brand identity. Deliberately NOT derived from this package's `name`:
// the workspace root package is already named "lunos" (XCOD-4), so naming this
// package "lunos" too would create a duplicate workspace name. Keep the internal
// package name as-is and brand only what npm/Homebrew/AUR consumers actually see.
const brand = "lunos"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

// XCOD-49: npm rate-limits bursts of new-package creation and answers E429. Back off and
// retry rather than failing the release — a 429 is a "try again", not a rejection. The
// re-check between attempts matters: npm can create the package server-side and still
// return 429, in which case retrying would fail with EPUBLISHCONFLICT instead.
const RETRY_DELAYS_SECONDS = [5, 15, 45, 90, 180]

async function publishWithRetry(dir: string, name: string, version: string) {
  for (let attempt = 0; ; attempt++) {
    const result = await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir).nothrow().quiet()
    const output = result.stdout.toString() + result.stderr.toString()
    if (result.exitCode === 0) {
      console.log(output.trim())
      return
    }
    const rateLimited = /E429|Too Many Requests|rate limit/i.test(output)
    if (!rateLimited || attempt >= RETRY_DELAYS_SECONDS.length) {
      console.error(output.trim())
      throw new Error(`failed to publish ${name}@${version} (exit ${result.exitCode})`)
    }
    if (await published(name, version)) {
      console.log(`already published ${name}@${version} — npm returned 429 but the write landed`)
      return
    }
    const delay = RETRY_DELAYS_SECONDS[attempt]
    console.log(`npm rate-limited ${name}@${version}; retrying in ${delay}s`)
    await Bun.sleep(delay * 1000)
  }
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  await publishWithRetry(dir, name, version)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  binaries[pkg.name] = pkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${brand}`
await $`mkdir -p ./dist/${brand}/bin`
await $`cp ./script/postinstall.mjs ./dist/${brand}/postinstall.mjs`
await Bun.file(`./dist/${brand}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${brand}/bin/${brand}.exe`).write(
  [
    `echo "Error: ${brand}-ai's postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${brand}-ai && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${brand}-ai without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${brand}/package.json`).write(
  JSON.stringify(
    {
      name: brand + "-ai",
      bin: {
        [brand]: `./bin/${brand}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

// XCOD-49: published serially, not with Promise.all. Firing ~11 concurrent `npm publish`
// calls is what trips npm's new-package rate limit in the first place, and Promise.all
// rejects on the first failure — so a single 429 aborted the run before `${brand}-ai`
// below was ever published, leaving the platform packages on npm with no entry point.
// Serial publishing costs a couple of minutes and removes both failure modes.
for (const [name] of Object.entries(binaries)) {
  await publish(`./dist/${name}`, name, binaries[name])
}

// Must come last: its optionalDependencies point at every platform package above, so
// publishing it first would briefly advertise versions that do not exist yet.
await publish(`./dist/${brand}`, `${brand}-ai`, version)

// Repository moved pminev1 -> AxsionDev on 2026-09-18; ghcr namespaces follow the owner.
const image = "ghcr.io/axsiondev/lunos"
const platforms = "linux/amd64,linux/arm64"
const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
const tagFlags = tags.flatMap((t) => ["-t", t])

// registries
if (!Script.preview) {
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  // Calculate SHA values
  const arm64Sha = await $`sha256sum ./dist/lunos-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/lunos-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/lunos-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/lunos-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  // arch
  const binaryPkgbuild = [
    "# Maintainer: dax",
    "# Maintainer: adam",
    "",
    "pkgname='lunos-bin'",
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The AI coding agent built for the terminal.'",
    "url='https://github.com/AxsionDev/Lunos'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('lunos')",
    "conflicts=('opencode')",
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/AxsionDev/Lunos/releases/download/v\${pkgver}\${_subver}/lunos-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,

    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/AxsionDev/Lunos/releases/download/v\${pkgver}\${_subver}/lunos-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./opencode "${pkgdir}/usr/bin/opencode"',
    "}",
    "",
  ].join("\n")

  // XCOD-49: disabled by default on this fork. The AUR leg needs AUR_KEY and SSH access to
  // aur.archlinux.org for a `lunos-bin` package that does not exist yet, and it has never been
  // exercised here. Set LUNOS_PUBLISH_AUR=1 once the package and key are provisioned.
  if (process.env.LUNOS_PUBLISH_AUR === "1") {
    for (const [pkg, pkgbuild] of [["lunos-bin", binaryPkgbuild]]) {
      for (let i = 0; i < 30; i++) {
        try {
          await $`rm -rf ./dist/aur-${pkg}`
          await $`git clone ssh://aur@aur.archlinux.org/${pkg}.git ./dist/aur-${pkg}`
          await $`cd ./dist/aur-${pkg} && git checkout master`
          await Bun.file(`./dist/aur-${pkg}/PKGBUILD`).write(pkgbuild)
          await $`cd ./dist/aur-${pkg} && makepkg --printsrcinfo > .SRCINFO`
          await $`cd ./dist/aur-${pkg} && git add PKGBUILD .SRCINFO`
          if ((await $`cd ./dist/aur-${pkg} && git diff --cached --quiet`.nothrow()).exitCode === 0) break
          await $`cd ./dist/aur-${pkg} && git commit -m "Update to v${Script.version}"`
          await $`cd ./dist/aur-${pkg} && git push`
          break
        } catch {
          continue
        }
      }
    }
  } else {
    console.log("skipping AUR publish (set LUNOS_PUBLISH_AUR=1 to enable)")
  }

  // Homebrew formula
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by GoReleaser. DO NOT EDIT.",
    "class Opencode < Formula",
    `  desc "The AI coding agent built for the terminal."`,
    `  homepage "https://github.com/AxsionDev/Lunos"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/AxsionDev/Lunos/releases/download/v${Script.version}/lunos-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/AxsionDev/Lunos/releases/download/v${Script.version}/lunos-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/AxsionDev/Lunos/releases/download/v${Script.version}/lunos-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/AxsionDev/Lunos/releases/download/v${Script.version}/lunos-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  // XCOD-49: disabled by default on this fork, and this one is not merely a missing credential.
  // The tap below is `anomalyco/homebrew-tap` — UPSTREAM's repository — and the formula is written
  // as `opencode.rb`. Given a token with the right scope this leg would attempt to write into a
  // third party's repo under the wrong filename. Re-enabling requires pointing LUNOS_HOMEBREW_TAP
  // at a Lunos-owned tap first; the formula class name would need renaming from Opencode too.
  if (process.env.LUNOS_PUBLISH_HOMEBREW === "1") {
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      console.error("GITHUB_TOKEN is required to update homebrew tap")
      process.exit(1)
    }
    const tapRepo = process.env.LUNOS_HOMEBREW_TAP
    if (!tapRepo) {
      console.error("LUNOS_HOMEBREW_TAP is required (e.g. AxsionDev/homebrew-tap) — refusing to")
      console.error("fall back to anomalyco/homebrew-tap, which belongs to upstream.")
      process.exit(1)
    }
    const tap = `https://x-access-token:${token}@github.com/${tapRepo}.git`
    await $`rm -rf ./dist/homebrew-tap`
    await $`git clone ${tap} ./dist/homebrew-tap`
    await Bun.file("./dist/homebrew-tap/lunos.rb").write(homebrewFormula)
    await $`cd ./dist/homebrew-tap && git add lunos.rb`
    if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
      await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
      await $`cd ./dist/homebrew-tap && git push`
    }
  } else {
    console.log("skipping Homebrew publish (set LUNOS_PUBLISH_HOMEBREW=1 and LUNOS_HOMEBREW_TAP)")
  }
}
