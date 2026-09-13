import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { listPlugins, pluginInstallSpec, searchPlugins } from "../../src/cli/cmd/plug"
import type { MarketplaceCtx, MarketplaceListDeps } from "../../src/cli/cmd/marketplace"
import type { FetchDeps } from "../../src/marketplace/shared"
import { tmpdir } from "../fixture/fixture"

const manifest = {
  name: "lunos-community",
  owner: { name: "Lunos Community" },
  plugins: [
    {
      name: "weather-widget",
      description: "Shows the weather in the status bar",
      category: "ui",
      tags: ["widget", "status-bar"],
      source: { type: "npm", package: "opencode-weather-widget", version: "1.2.0" },
    },
    {
      name: "vim-bindings",
      description: "Adds vim keybindings",
      category: "editing",
      tags: ["keybindings"],
      source: { type: "github", repo: "someone/vim-bindings", ref: "main" },
    },
    {
      name: "no-frills",
      source: { type: "npm", package: "no-frills-plugin" },
    },
  ],
}

function ctx(dir: string): MarketplaceCtx {
  return { vcs: "git", worktree: dir, directory: dir }
}

function listDeps(global: string, resolve: FetchDeps): MarketplaceListDeps {
  return {
    exists: (file) => Filesystem.exists(file),
    readText: (file) => Filesystem.readText(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    resolve,
    global,
  }
}

const resolveDeps: FetchDeps = {
  fetchText: async (url) => {
    if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
    return JSON.stringify(manifest)
  },
  readText: async () => "",
  stat: async () => undefined,
}

async function withMarketplace(tmp: string) {
  const cfgFile = path.join(tmp, ".opencode", "opencode.json")
  await fs.mkdir(path.dirname(cfgFile), { recursive: true })
  await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))
}

describe("pluginInstallSpec", () => {
  test("npm source without version returns bare package name", () => {
    expect(pluginInstallSpec({ type: "npm", package: "foo" })).toBe("foo")
  })

  test("npm source with version appends @version", () => {
    expect(pluginInstallSpec({ type: "npm", package: "foo", version: "2.0.0" })).toBe("foo@2.0.0")
  })

  test("github source without ref returns bare repo", () => {
    expect(pluginInstallSpec({ type: "github", repo: "owner/repo" })).toBe("owner/repo")
  })

  test("github source with ref appends #ref", () => {
    expect(pluginInstallSpec({ type: "github", repo: "owner/repo", ref: "v2" })).toBe("owner/repo#v2")
  })
})

describe("plugin.list", () => {
  test("returns a clear zero-marketplace result when nothing is added", async () => {
    await using tmp = await tmpdir()
    const result = await listPlugins(ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(result.marketplaceCount).toBe(0)
    expect(result.plugins).toEqual([])
  })

  test("flattens plugins from every added marketplace with marketplace name and install spec", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path)

    const result = await listPlugins(ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(result.marketplaceCount).toBe(1)
    expect(result.plugins).toEqual([
      {
        name: "weather-widget",
        marketplace: "lunos-community",
        description: "Shows the weather in the status bar",
        category: "ui",
        tags: ["widget", "status-bar"],
        spec: "opencode-weather-widget@1.2.0",
      },
      {
        name: "vim-bindings",
        marketplace: "lunos-community",
        description: "Adds vim keybindings",
        category: "editing",
        tags: ["keybindings"],
        spec: "someone/vim-bindings#main",
      },
      {
        name: "no-frills",
        marketplace: "lunos-community",
        description: undefined,
        category: undefined,
        tags: undefined,
        spec: "no-frills-plugin",
      },
    ])
  })

  test("counts the marketplace but yields no plugins when it is unreachable", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path)

    const result = await listPlugins(
      ctx(tmp.path),
      listDeps(path.join(tmp.path, "global"), {
        fetchText: async () => {
          throw new Error("404")
        },
        readText: async () => "",
        stat: async () => undefined,
      }),
    )
    expect(result.marketplaceCount).toBe(1)
    expect(result.plugins).toEqual([])
  })
})

describe("plugin.search", () => {
  test("is case-insensitive on name", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path)

    const result = await searchPlugins("WEATHER", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(result.marketplaceCount).toBe(1)
    expect(result.plugins.map((p) => p.name)).toEqual(["weather-widget"])
  })

  test("matches on description substring", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path)

    const result = await searchPlugins("keybindings", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(result.plugins.map((p) => p.name)).toEqual(["vim-bindings"])
  })

  test("matches on category and tags", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path)

    const byCategory = await searchPlugins("editing", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(byCategory.plugins.map((p) => p.name)).toEqual(["vim-bindings"])

    const byTag = await searchPlugins("status-bar", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(byTag.plugins.map((p) => p.name)).toEqual(["weather-widget"])
  })

  test("returns no plugins when nothing matches, but still reports the marketplace count", async () => {
    await using tmp = await tmpdir()
    await withMarketplace(tmp.path)

    const result = await searchPlugins("nonexistent", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(result.marketplaceCount).toBe(1)
    expect(result.plugins).toEqual([])
  })

  test("reports zero marketplaces distinctly from zero matches", async () => {
    await using tmp = await tmpdir()
    const result = await searchPlugins("weather", ctx(tmp.path), listDeps(path.join(tmp.path, "global"), resolveDeps))
    expect(result.marketplaceCount).toBe(0)
    expect(result.plugins).toEqual([])
  })
})
