import { describe, expect, test } from "bun:test"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { readFileSync } from "fs"
import path from "path"
import valid from "./fixtures/marketplace/valid.json"
import validMcp from "./fixtures/marketplace/valid-mcp.json"
import malformed from "./fixtures/marketplace/malformed.json"

// Read from disk rather than statically importing — the seed manifest lives at the repo
// root (packages/opencode/specs/marketplace-manifest.md documents why), outside this
// package's own rootDir.
const seedPath = path.join(import.meta.dir, "../../../marketplace.json")

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

  test("decodes the seed community manifest at the repo root", () => {
    const json = JSON.parse(readFileSync(seedPath, "utf8"))
    const manifest = Marketplace.decode(json)
    expect(manifest.name).toBe("lunos-community")
    expect(manifest.plugins.length).toBeGreaterThan(0)
    for (const plugin of manifest.plugins) {
      expect(plugin.source.type).toBe("github")
    }
  })

  test("decodes a manifest carrying MCP servers", () => {
    const manifest = Marketplace.decode(validMcp)
    expect(manifest.mcp).toHaveLength(2)
    expect(manifest.mcp?.[0]).toMatchObject({
      name: "filesystem",
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
    })
    expect(manifest.mcp?.[1]).toMatchObject({ name: "context-api", type: "remote", url: "https://example.test/mcp" })
  })

  test("keeps decoding a manifest with no mcp key at all", () => {
    // `mcp` is optional so that every manifest published before this change keeps working.
    const manifest = Marketplace.decode(valid)
    expect(manifest.mcp).toBeUndefined()
  })

  test("rejects an MCP entry whose type is neither local nor remote", () => {
    expect(() =>
      Marketplace.decode({
        name: "x",
        owner: { name: "o" },
        plugins: [],
        mcp: [{ name: "bad", type: "carrier-pigeon", url: "https://example.test" }],
      }),
    ).toThrow(/\["mcp"\]\[0\]/)
  })
})
