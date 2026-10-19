import { describe, expect, test } from "bun:test"
import {
  manualInstallCommand,
  versionDetail,
  versionLabel,
  versionVerbose,
} from "@opencode-ai/core/installation/version"

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

describe("versionVerbose", () => {
  const sync = {
    commit: "b471c2b4495747353af768fbf2e0790c9d820ce2",
    measuredAt: "2026-09-27",
    daysBehind: 0,
    commitsBehind: 0,
  }

  test("adds the upstream commit and lag from the last sync", () => {
    expect(versionVerbose("1.18.41", "1.18.32", sync)).toBe(
      "Lunos v1.18.41 · based on opencode 1.18.32\nupstream: anomalyco/opencode dev @ b471c2b449, up to date with upstream as of 2026-09-27",
    )
  })

  test("uses the same wording as the upstream-sync workflow when behind", () => {
    expect(versionVerbose("1.18.41", "1.18.32", { ...sync, daysBehind: 8, commitsBehind: 63 })).toContain(
      "8 days behind upstream (63 commits) as of 2026-09-27",
    )
  })

  test("says so when the build has no sync recorded", () => {
    expect(versionVerbose("1.18.41", "1.18.32", undefined)).toBe(
      "Lunos v1.18.41 · based on opencode 1.18.32\nupstream lag: not recorded in this build",
    )
  })
})
