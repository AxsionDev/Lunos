import { describe, expect, test } from "bun:test"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { readFileSync } from "fs"
import path from "path"
import valid from "./fixtures/marketplace/valid.json"
import validMcp from "./fixtures/marketplace/valid-mcp.json"
import malformed from "./fixtures/marketplace/malformed.json"
import validAllKinds from "./fixtures/marketplace/valid-all-kinds.json"

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

  // `github` plugin sources install through npm's git-dep path, which npm 12 disables by default
  // (allow-git=none) and which Arborist cannot prepare for repos with a build step or
  // `workspace:*` deps. This manifest is what `lunos marketplace add AxsionDev/Lunos` serves, so
  // every plugin in it must install from the npm registry.
  test("decodes the seed community manifest and sources every plugin from npm", () => {
    const manifest = Marketplace.decode(JSON.parse(readFileSync(seedPath, "utf8")))
    expect(manifest.name).toBe("lunos-community")
    expect(manifest.plugins.length).toBeGreaterThan(0)
    const notNpm = manifest.plugins.filter((plugin) => plugin.source.type !== "npm").map((plugin) => plugin.name)
    expect(notNpm).toEqual([])
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

  test("decodes a manifest carrying all four content kinds", () => {
    const manifest = Marketplace.decode(validAllKinds)
    expect(manifest.plugins.map((x) => x.name)).toEqual(["a-plugin"])
    expect(manifest.mcp?.map((x) => x.name)).toEqual(["a-server"])
    expect(manifest.skills?.[0]).toMatchObject({ name: "team-skills", url: "https://example.test/.well-known/skills/" })
    expect(manifest.hooks?.[0]).toMatchObject({
      name: "format-on-edit",
      event: "tool.execute.after",
      command: ["prettier", "--write", "."],
      matcher: { tool: "edit", file: "**/*.ts" },
    })
  })

  test("keeps decoding a plugin-only manifest with no skills or hooks key", () => {
    const manifest = Marketplace.decode(valid)
    expect(manifest.skills).toBeUndefined()
    expect(manifest.hooks).toBeUndefined()
  })

  // A hook for an event this Lunos doesn't know must not take the rest of the manifest down with
  // it; the event is checked when that one hook is installed.
  test("accepts a hook whose event this version does not know", () => {
    const manifest = Marketplace.decode({
      ...validAllKinds,
      hooks: [{ name: "future", event: "session.someday", command: ["true"] }],
    })
    expect(manifest.plugins).toHaveLength(1)
    expect(manifest.hooks?.[0]?.event).toBe("session.someday")
  })

  test("rejects a skill entry with no url", () => {
    expect(() => Marketplace.decode({ ...validAllKinds, skills: [{ name: "no-url" }] })).toThrow(/\["skills"\]\[0\]/)
  })
})
