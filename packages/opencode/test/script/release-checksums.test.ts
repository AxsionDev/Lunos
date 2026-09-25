import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import {
  BUNDLE_SUFFIX,
  IDENTITY_REGEXP,
  OIDC_ISSUER,
  SUMS,
  checksums,
  formatSums,
  isChecksummed,
  isSbom,
} from "../../script/release-checksums"

describe("release checksums (XCOD-106)", () => {
  test("SHA256SUMS never lists itself or a signature bundle", () => {
    expect(isChecksummed("lunos-linux-x64.tar.gz")).toBe(true)
    expect(isChecksummed("lunos-sbom-1.18.40.cdx.json")).toBe(true)
    expect(isChecksummed(SUMS)).toBe(false)
    expect(isChecksummed(`${SUMS}${BUNDLE_SUFFIX}`)).toBe(false)
    expect(isChecksummed(`lunos-sbom-1.18.40.cdx.json${BUNDLE_SUFFIX}`)).toBe(false)
  })

  test("picks out the SBOM to sign", () => {
    expect(isSbom("lunos-sbom-1.18.40.cdx.json")).toBe(true)
    expect(isSbom("lunos-sbom-1.18.40.cdx.json.sigstore.json")).toBe(false)
    expect(isSbom("lunos-linux-x64.tar.gz")).toBe(false)
  })

  test("is sorted, so the same assets give the same file", () => {
    expect(
      formatSums([
        { name: "b.zip", hash: "2".repeat(64) },
        { name: "a.tar.gz", hash: "1".repeat(64) },
      ]),
    ).toBe(`${"1".repeat(64)}  a.tar.gz\n${"2".repeat(64)}  b.zip\n`)
  })

  test("checks out with the system's own sha256 tool, and catches a tampered file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lunos-sums-"))
    try {
      await writeFile(path.join(dir, "lunos-linux-x64.tar.gz"), "binary")
      await writeFile(path.join(dir, "lunos-sbom-9.9.9.cdx.json"), "{}")
      await writeFile(path.join(dir, `${SUMS}${BUNDLE_SUFFIX}`), "not listed")
      await writeFile(path.join(dir, SUMS), await checksums(dir))

      const tool = process.platform === "darwin" ? ["shasum", "-a", "256"] : ["sha256sum"]
      const ok = await $`${tool} -c ${SUMS}`.cwd(dir).nothrow().quiet()
      expect(ok.exitCode).toBe(0)

      await writeFile(path.join(dir, "lunos-linux-x64.tar.gz"), "tampered")
      const bad = await $`${tool} -c ${SUMS}`.cwd(dir).nothrow().quiet()
      expect(bad.exitCode).not.toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Reviewers copy the verify command from the deployment guide. It must name the signer
  // this script actually signs as, or every correct release would fail verification.
  test("the deployment guide verifies against the identity releases are signed with", async () => {
    const guide = await Bun.file(new URL("../../../../docs/deployment/self-hosted.md", import.meta.url)).text()
    expect(guide).toContain(`--certificate-identity-regexp '${IDENTITY_REGEXP}'`)
    expect(guide).toContain(`--certificate-oidc-issuer ${OIDC_ISSUER}`)
    expect(guide).toContain(`--bundle ${SUMS}${BUNDLE_SUFFIX}`)
  })

  test("the identity only matches this repository's publish workflow", () => {
    const re = new RegExp(IDENTITY_REGEXP)
    expect(re.test("https://github.com/AxsionDev/Lunos/.github/workflows/publish.yml@refs/heads/dev")).toBe(true)
    expect(re.test("https://github.com/AxsionDev/Lunos/.github/workflows/other.yml@refs/heads/dev")).toBe(false)
    expect(re.test("https://github.com/evil/Lunos/.github/workflows/publish.yml@refs/heads/dev")).toBe(false)
    expect(re.test("https://github.com/AxsionDevXLunos/.github/workflows/publish.yml@refs/heads/dev")).toBe(false)
  })
})
