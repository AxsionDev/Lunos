import { describe, expect, test } from "bun:test"
import { Marketplace } from "@opencode-ai/core/marketplace"
import valid from "./fixtures/marketplace/valid.json"
import malformed from "./fixtures/marketplace/malformed.json"

describe("Marketplace", () => {
  test("decodes a valid manifest", () => {
    const manifest = Marketplace.decode(valid)
    expect(manifest.name).toBe("lunos-community")
    expect(manifest.plugins).toHaveLength(2)
    expect(manifest.plugins[0]?.source).toMatchObject({
      type: "npm",
      package: "@lunos-community/conventional-commits",
    })
    expect(manifest.plugins[1]?.source).toMatchObject({
      type: "github",
      repo: "lunos-community/rust-analyzer-bridge",
    })
  })

  test("rejects a malformed manifest with a clear, actionable error", () => {
    expect(() => Marketplace.decode(malformed)).toThrow(/\["plugins"\]\[0\]\["source"\]/)
  })
})
