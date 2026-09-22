import { describe, expect, test } from "bun:test"
import { resolveByName } from "../../src/marketplace/resolve"
import { mcpConfigFromEntry } from "../../src/mcp/discover"
import { resolvesFromMarketplace } from "../../src/cli/cmd/mcp"

// The yargs handler is driven by Effect and interactive prompts, so the pure decision logic it
// delegates to is what gets asserted here. The prompting itself is exercised by hand — see
// task-5-report.md's manual verification transcript.
const rows = [
  {
    name: "filesystem",
    marketplace: "lunos-community",
    entry: { name: "filesystem", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"] },
  },
  {
    name: "filesystem",
    marketplace: "acme-internal",
    entry: { name: "filesystem", type: "local", command: ["npx", "-y", "acme-fs"] },
  },
]

describe("mcp add <name> resolution", () => {
  test("an ambiguous name yields both candidates so the caller can refuse", () => {
    const matches = resolveByName(rows, "filesystem")
    expect(matches.map((m) => `${m.marketplace}/${m.name}`)).toEqual([
      "lunos-community/filesystem",
      "acme-internal/filesystem",
    ])
  })

  test("a qualified name resolves to exactly one config", () => {
    const matches = resolveByName(rows, "acme-internal/filesystem")
    expect(matches).toHaveLength(1)
    expect(mcpConfigFromEntry(matches[0]!.entry as any)).toMatchObject({
      type: "local",
      command: ["npx", "-y", "acme-fs"],
    })
  })
})

// resolvesFromMarketplace is the actual new logic in this task: it decides whether `mcp add`
// takes the marketplace branch at all. Every existing invocation shape must come back false so
// it falls through to unchanged behaviour; only a bare name with nothing else set comes back true.
describe("resolvesFromMarketplace", () => {
  test("a bare name with no other flags takes the marketplace path", () => {
    expect(resolvesFromMarketplace({ name: "filesystem" }, [])).toBe(true)
  })

  test("no name at all never takes the marketplace path (interactive wizard instead)", () => {
    expect(resolvesFromMarketplace({}, [])).toBe(false)
  })

  test("--url makes the invocation explicit, even with a name", () => {
    expect(resolvesFromMarketplace({ name: "filesystem", url: "https://example.com/mcp" }, [])).toBe(false)
  })

  test("--env makes the invocation explicit", () => {
    expect(resolvesFromMarketplace({ name: "filesystem", env: ["KEY=value"] }, [])).toBe(false)
  })

  test("an empty --env array does not count as explicit", () => {
    expect(resolvesFromMarketplace({ name: "filesystem", env: [] }, [])).toBe(true)
  })

  test("--header makes the invocation explicit", () => {
    expect(resolvesFromMarketplace({ name: "filesystem", header: ["X-Key=value"] }, [])).toBe(false)
  })

  test("a trailing `--` command makes the invocation explicit", () => {
    expect(resolvesFromMarketplace({ name: "filesystem" }, ["npx", "-y", "pkg"])).toBe(false)
  })
})
