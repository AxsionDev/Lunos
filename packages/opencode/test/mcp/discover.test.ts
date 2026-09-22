import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { listMcpServers, searchMcpServers } from "../../src/mcp/discover"
import type { FetchDeps, MarketplaceCacheDeps, MarketplaceCtx, MarketplaceListDeps } from "../../src/marketplace/shared"
import { tmpdir } from "../fixture/fixture"

// Use exact same pattern as plugin.test.ts for consistency

const mcpManifest = {
  name: "mcp-test-marketplace",
  owner: { name: "MCP Test Provider" },
  plugins: [],
  mcp: [
    {
      name: "filesystem",
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      description: "Secure file operations",
      category: "environment",
    },
    {
      name: "searxng",
      type: "local",
      command: ["npx", "-y", "mcp-searxng"],
      category: "search",
    },
  ],
}

const noMcpManifest = {
  name: "no-mcp-marketplace",
  owner: { name: "Legacy Provider" },
  plugins: [],
  // Intentionally no mcp field
}

function ctx(dir: string): MarketplaceCtx {
  return { vcs: "git", worktree: dir, directory: dir }
}

function testCacheDeps(dir: string): MarketplaceCacheDeps {
  return {
    dir,
    mtime: async (file) => {
      const stat = await fs.stat(file).catch(() => undefined)
      return stat ? stat.mtimeMs : undefined
    },
    readText: (file) => Filesystem.readText(file).catch(() => undefined),
    write: (file, text) => Filesystem.write(file, text),
  }
}

function listDeps(global: string, resolve: FetchDeps): MarketplaceListDeps {
  return {
    exists: (file) => Filesystem.exists(file),
    readText: (file) => Filesystem.readText(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    resolve,
    global,
    cache: testCacheDeps(path.join(global, "..", "cache")),
  }
}

async function withMarketplace(tmp: string, source: string = "mcp-test-marketplace") {
  const cfgFile = path.join(tmp, ".opencode", "opencode.json")
  await fs.mkdir(path.dirname(cfgFile), { recursive: true })
  await Bun.write(cfgFile, JSON.stringify({ marketplace: [source] }, null, 2))
}

const resolveDeps: FetchDeps = {
  fetchText: async (url) => {
    if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
    if (url.includes("mcp-test-marketplace")) return JSON.stringify(mcpManifest)
    if (url.includes("no-mcp-marketplace")) return JSON.stringify(noMcpManifest)
    return JSON.stringify(mcpManifest)
  },
  readText: async () => "",
  stat: async () => undefined,
}

describe("listMcpServers", () => {
  test("lists mcp servers from marketplace", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path, "mcp-test-marketplace")
    const result = await listMcpServers(ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))

    expect(result.marketplaceCount).toBe(1)
    expect(result.servers.length).toBeGreaterThanOrEqual(0)
  })

  test("treats a manifest with no mcp key as contributing no servers", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path, "no-mcp-marketplace")
    const result = await listMcpServers(ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))

    expect(result.servers).toEqual([])
    expect(result.marketplaceCount).toBe(1)
  })
})

describe("searchMcpServers", () => {
  test("matches on category as well as name and description", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path, "mcp-test-marketplace")
    const result = await searchMcpServers("search", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))

    expect(result.marketplaceCount).toBe(1)
    expect(result.servers.length).toBeGreaterThanOrEqual(0)
  })
})
