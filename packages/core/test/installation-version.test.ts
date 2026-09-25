import { describe, expect, test } from "bun:test"
import { manualInstallCommand, versionDetail, versionLabel } from "@opencode-ai/core/installation/version"

describe("manualInstallCommand", () => {
  test("allows lunos-ai's postinstall, which npm 12 skips by default", () => {
    expect(manualInstallCommand("1.18.40")).toBe("npm i -g lunos-ai@1.18.40 --allow-scripts=lunos-ai")
  })

  test("leaves the version off when there's no target", () => {
    expect(manualInstallCommand()).toBe("npm i -g lunos-ai --allow-scripts=lunos-ai")
  })
})

describe("versionLabel", () => {
  test("names the product next to the version", () => {
    expect(versionLabel("1.18.38")).toBe("Lunos v1.18.38")
  })

  test("says what a local build is instead of the bare word 'local'", () => {
    expect(versionLabel("local")).toBe("Lunos dev (local build)")
  })
})

describe("versionDetail", () => {
  test("adds the upstream base when the build knows it", () => {
    expect(versionDetail("1.18.38", "1.18.31")).toBe("Lunos v1.18.38 · based on opencode 1.18.31")
  })

  test("falls back to the label when it doesn't", () => {
    expect(versionDetail("1.18.38", undefined)).toBe("Lunos v1.18.38")
  })
})
