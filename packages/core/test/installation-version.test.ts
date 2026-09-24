import { describe, expect, test } from "bun:test"
import { versionDetail, versionLabel } from "@opencode-ai/core/installation/version"

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
