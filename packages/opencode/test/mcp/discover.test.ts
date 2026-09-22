import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { listMcpServers, searchMcpServers, mcpConfigFromEntry } from "../../src/mcp/discover"
import type { FetchDeps, MarketplaceCacheDeps, MarketplaceCtx, MarketplaceListDeps } from "../../src/marketplace/shared"
import { tmpdir } from "../fixture/fixture"

// Use exact same pattern as plugin.test.ts for consistency

const mcpManifestA = {
  name: "mcp-marketplace-a",
  owner: { name: "MCP Provider A" },
  plugins: [],
  mcp: [
    {
      name: "filesystem",
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      description: "Secure file operations",
      category: "environment",
    },
  ],
}

const mcpManifestB = {
  name: "mcp-marketplace-b",
  owner: { name: "MCP Provider B" },
  plugins: [],
  mcp: [
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

const searchManifest = {
  name: "search-test-marketplace",
  owner: { name: "Search Test Provider" },
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

async function withMarketplace(tmp: string, source: string = "acme/mcp-test") {
  const cfgFile = path.join(tmp, ".opencode", "opencode.json")
  await fs.mkdir(path.dirname(cfgFile), { recursive: true })
  await Bun.write(cfgFile, JSON.stringify({ marketplace: [source] }, null, 2))
}

const resolveDeps: FetchDeps = {
  fetchText: async (url) => {
    if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
    if (url.includes("acme/mcp-a")) return JSON.stringify(mcpManifestA)
    if (url.includes("acme/mcp-b")) return JSON.stringify(mcpManifestB)
    if (url.includes("acme/no-mcp")) return JSON.stringify(noMcpManifest)
    if (url.includes("acme/search-test")) return JSON.stringify(searchManifest)
    return JSON.stringify(mcpManifestA)
  },
  readText: async () => "",
  stat: async () => undefined,
}

describe("listMcpServers", () => {
  test("merges servers from every added marketplace", async () => {
    await using tmp = await tmpdir()
    // Write config with two marketplace sources
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["acme/mcp-a", "acme/mcp-b"] }, null, 2))

    const result = await listMcpServers(ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))

    // Assert marketplaces actually loaded (proof manifests were fetched)
    expect(result.marketplaces).toHaveLength(2)
    expect(result.servers.map((s) => s.name)).toEqual(["filesystem", "searxng"])
    expect(result.servers[0]?.marketplace).toBe("mcp-marketplace-a")
    expect(result.servers[1]?.marketplace).toBe("mcp-marketplace-b")
  })

  test("treats a manifest with no mcp key as contributing no servers", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path, "acme/no-mcp")
    const result = await listMcpServers(ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))

    // Assert marketplace loaded (proof manifest was fetched)
    expect(result.marketplaces).toHaveLength(1)
    // Assert backward compat: no mcp key → no servers
    expect(result.servers).toEqual([])
  })
})

describe("searchMcpServers", () => {
  test("matches on category as well as name and description", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path, "acme/search-test")
    const result = await searchMcpServers("search", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))

    // Assert marketplace loaded (proof manifest was fetched)
    expect(result.marketplaces).toHaveLength(1)
    // Assert search filters by category: only the "search" category entry should match
    expect(result.servers.map((s) => s.name)).toEqual(["searxng"])
  })
})

describe("mcpConfigFromEntry", () => {
  test("turns a local entry into a local config with its command intact", () => {
    const localEntry = {
      name: "filesystem",
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      description: "Secure file operations",
      category: "environment",
    }
    const config = mcpConfigFromEntry(localEntry as any)
    expect(config).toMatchObject({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
      enabled: true,
    })
  })

  test("writes an {env:} reference for each required variable, never a value", () => {
    // The whole point: a generated opencode.json holds no secrets and stays safe to commit.
    const localWithEnv = {
      name: "x",
      type: "local",
      command: ["npx", "-y", "x"],
      environment: ["EXAMPLE_API_KEY"],
    }
    const config = mcpConfigFromEntry(localWithEnv as any)
    expect((config as any).environment).toEqual({ EXAMPLE_API_KEY: "{env:EXAMPLE_API_KEY}" })
  })

  test("turns a remote entry into a remote config with {env:} headers", () => {
    const remoteEntry = {
      name: "y",
      type: "remote",
      url: "https://example.test/mcp",
      headers: ["EXAMPLE_API_KEY"],
    }
    const config = mcpConfigFromEntry(remoteEntry as any)
    expect(config).toMatchObject({
      type: "remote",
      url: "https://example.test/mcp",
      headers: { EXAMPLE_API_KEY: "{env:EXAMPLE_API_KEY}" },
    })
  })

  test("omits environment entirely when the entry declares none", () => {
    const localNoEnv = {
      name: "searxng",
      type: "local",
      command: ["npx", "-y", "mcp-searxng"],
      category: "search",
    }
    const config = mcpConfigFromEntry(localNoEnv as any)
    expect((config as any).environment).toBeUndefined()
    expect("environment" in config).toBe(false)
  })
})
