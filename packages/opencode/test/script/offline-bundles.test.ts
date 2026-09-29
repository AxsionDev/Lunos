import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { bundleFiles, bundleName, cliArchives, unsigned } from "../../script/offline-bundles"
import { RIPGREP_VERSION, download, toolsFor } from "../../script/offline/tools"

const release = [
  "lunos-linux-x64.tar.gz",
  "lunos-linux-arm64-musl.tar.gz",
  "lunos-darwin-arm64.zip",
  "lunos-windows-x64.zip",
  "lunos-desktop-mac-arm64.dmg",
  "lunos-sbom-1.18.41.cdx.json",
  "lunos-sbom-1.18.41.cdx.json.sigstore.json",
  "SHA256SUMS",
  "SHA256SUMS.sigstore.json",
  "lunos-models-snapshot.json",
  "INSTALL-OFFLINE.md",
  "latest.yml",
]

describe("offline bundles", () => {
  test("one bundle per CLI archive, never for desktop builds or metadata", () => {
    expect(cliArchives(release)).toEqual([
      "lunos-darwin-arm64.zip",
      "lunos-linux-arm64-musl.tar.gz",
      "lunos-linux-x64.tar.gz",
      "lunos-windows-x64.zip",
    ])
    expect(bundleName("lunos-linux-x64.tar.gz")).toBe("lunos-offline-linux-x64.tar.gz")
    expect(bundleName("lunos-windows-x64.zip")).toBe("lunos-offline-windows-x64.tar.gz")
  })

  test("carries the SBOM, the signed checksums, the snapshot and the instructions", () => {
    expect(bundleFiles(release).sort()).toEqual(
      [
        "INSTALL-OFFLINE.md",
        "SHA256SUMS",
        "SHA256SUMS.sigstore.json",
        "lunos-models-snapshot.json",
        "lunos-sbom-1.18.41.cdx.json",
        "lunos-sbom-1.18.41.cdx.json.sigstore.json",
      ].sort(),
    )
  })

  test("refuses a release without the snapshot or instructions, rather than shipping a partial bundle", () => {
    expect(() => bundleFiles(release.filter((name) => name !== "lunos-models-snapshot.json"))).toThrow(
      "release is missing lunos-models-snapshot.json",
    )
  })

  test("finds any file the signed SHA256SUMS doesn't cover", () => {
    const sums = "aa  lunos-linux-x64.tar.gz\nbb  lunos-models-snapshot.json\n"
    expect(
      unsigned(sums, [
        "lunos-linux-x64.tar.gz",
        "lunos-models-snapshot.json",
        "SHA256SUMS",
        "SHA256SUMS.sigstore.json",
      ]),
    ).toEqual([])
    expect(unsigned(sums, ["lunos-linux-x64.tar.gz", "INSTALL-OFFLINE.md"])).toEqual(["INSTALL-OFFLINE.md"])
  })

  test("bundles the tools for each archive's platform", () => {
    const linux = toolsFor("lunos-linux-x64-baseline-musl.tar.gz")
    expect(linux.rg?.url).toEndWith("ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz")
    expect(linux.cosign.url).toEndWith("cosign-linux-amd64")
    const windows = toolsFor("lunos-windows-arm64.zip")
    expect(windows.rg?.name).toBe("rg.exe")
    expect(windows.cosign.url).toEndWith("cosign-windows-amd64.exe")
    expect(toolsFor("lunos-darwin-arm64.zip").cosign.url).toEndWith("cosign-darwin-arm64")
    // No ripgrep build runs on arm64 musl.
    expect(toolsFor("lunos-linux-arm64-musl.tar.gz").rg).toBeUndefined()
    for (const archive of cliArchives(release)) expect(toolsFor(archive).cosign.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("bundles the ripgrep version Lunos would otherwise download", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../../core/src/ripgrep/binary.ts")).text()
    expect(source).toContain(`const VERSION = "${RIPGREP_VERSION}"`)
  })

  test("abandons a stalled download and retries it, instead of hanging the release", async () => {
    let requests = 0
    const body = "tool bytes"
    const server = Bun.serve({
      port: 0,
      // The first request never answers, as the stalled connection that hung v1.18.41 didn't.
      fetch: () => (++requests === 1 ? new Promise<Response>(() => {}) : new Response(body)),
    })
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-tools-"))
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    try {
      const file = await download({ url: `${server.url}tool`, sha256 }, cache, 200)
      expect(await Bun.file(file).text()).toBe(body)
      expect(requests).toBe(2)
      expect(await fs.readdir(cache)).toEqual(["tool"])
    } finally {
      server.stop(true)
    }
  })
})
