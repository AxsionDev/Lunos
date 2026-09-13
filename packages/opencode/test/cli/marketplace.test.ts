import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { createMarketplaceAddTask, listMarketplaces, type MarketplaceDeps } from "../../src/cli/cmd/marketplace"
import type { FetchDeps, MarketplaceCtx, MarketplaceListDeps } from "../../src/marketplace/shared"
import { tmpdir } from "../fixture/fixture"

const validManifest = {
  name: "lunos-community",
  owner: { name: "Lunos Community" },
  plugins: [
    { name: "a", source: { type: "npm", package: "a" } },
    { name: "b", source: { type: "npm", package: "b" } },
  ],
}

function addDeps(global: string, resolve: MarketplaceDeps["resolve"]): MarketplaceDeps {
  return {
    spinner: () => ({
      start() {},
      stop() {},
    }),
    log: {
      error() {},
      info() {},
      success() {},
    },
    resolve,
    readText: (file) => Filesystem.readText(file),
    write: async (file, text) => {
      await Filesystem.write(file, text)
    },
    exists: (file) => Filesystem.exists(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    global,
  }
}

function ctx(dir: string): MarketplaceCtx {
  return { vcs: "git", worktree: dir, directory: dir }
}

async function read(file: string) {
  return Filesystem.readJson<{ marketplace?: unknown[] }>(file)
}

describe("marketplace.add.task", () => {
  test("persists a resolved source to local config", async () => {
    await using tmp = await tmpdir()
    const run = createMarketplaceAddTask(
      { source: "pminev1/Lunos" },
      addDeps(path.join(tmp.path, "global"), async () => validManifest as never),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    const cfg = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    expect(cfg.marketplace).toEqual(["pminev1/Lunos"])
  })

  test("writes to global scope when --global is set", async () => {
    await using tmp = await tmpdir()
    const global = path.join(tmp.path, "global")
    const run = createMarketplaceAddTask(
      { source: "pminev1/Lunos", global: true },
      addDeps(global, async () => validManifest as never),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    expect(await Filesystem.exists(path.join(global, "opencode.jsonc"))).toBe(true)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("adding the same source twice is a no-op, not a duplicate", async () => {
    await using tmp = await tmpdir()
    const run = createMarketplaceAddTask(
      { source: "pminev1/Lunos" },
      addDeps(path.join(tmp.path, "global"), async () => validManifest as never),
    )

    expect(await run(ctx(tmp.path))).toBe(true)
    expect(await run(ctx(tmp.path))).toBe(true)

    const cfg = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    expect(cfg.marketplace).toEqual(["pminev1/Lunos"])
  })

  test("keeps existing marketplace entries and appends a new one", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["existing/repo"] }, null, 2))

    const run = createMarketplaceAddTask(
      { source: "pminev1/Lunos" },
      addDeps(path.join(tmp.path, "global"), async () => validManifest as never),
    )
    expect(await run(ctx(tmp.path))).toBe(true)

    const cfg = await read(cfgFile)
    expect(cfg.marketplace).toEqual(["existing/repo", "pminev1/Lunos"])
  })

  test("preserves JSONC comments when adding a marketplace", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(
      cfgFile,
      `{
  // head
  "marketplace": [
    // keep
    "existing/repo"
  ],
  // tail
  "model": "x"
}
`,
    )

    const run = createMarketplaceAddTask(
      { source: "pminev1/Lunos" },
      addDeps(path.join(tmp.path, "global"), async () => validManifest as never),
    )
    expect(await run(ctx(tmp.path))).toBe(true)

    const text = await fs.readFile(cfgFile, "utf8")
    expect(text).toContain("// head")
    expect(text).toContain("// keep")
    expect(text).toContain("// tail")

    const cfg = parseJsonc(text) as { marketplace?: unknown[] }
    expect(cfg.marketplace).toEqual(["existing/repo", "pminev1/Lunos"])
  })

  test("fails and persists nothing when the manifest is unreachable", async () => {
    await using tmp = await tmpdir()
    const run = createMarketplaceAddTask(
      { source: "pminev1/does-not-exist" },
      addDeps(path.join(tmp.path, "global"), async () => {
        throw new Error("404")
      }),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.json"))).toBe(false)
  })

  test("fails and persists nothing when the manifest fails schema validation", async () => {
    await using tmp = await tmpdir()
    const run = createMarketplaceAddTask(
      { source: "https://example.com/bad.json" },
      addDeps(path.join(tmp.path, "global"), async () => {
        throw new Error("Expected a valid marketplace manifest")
      }),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })
})

describe("marketplace.list", () => {
  function listDeps(global: string, resolve: FetchDeps): MarketplaceListDeps {
    return {
      exists: (file) => Filesystem.exists(file),
      readText: (file) => Filesystem.readText(file),
      files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
      resolve,
      global,
    }
  }

  test("shows an empty list when nothing is added", async () => {
    await using tmp = await tmpdir()
    const entries = await listMarketplaces(
      ctx(tmp.path),
      listDeps(path.join(tmp.path, "global"), {
        fetchText: async () => "",
        readText: async () => "",
        stat: async () => undefined,
      }),
    )
    expect(entries).toEqual([])
  })

  test("shows plugin count for a resolvable marketplace", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))

    const entries = await listMarketplaces(
      ctx(tmp.path),
      listDeps(path.join(tmp.path, "global"), {
        fetchText: async (url) => {
          if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
          return JSON.stringify(validManifest)
        },
        readText: async () => "",
        stat: async () => undefined,
      }),
    )

    expect(entries).toEqual([
      { scope: "local", source: "pminev1/Lunos", name: "lunos-community", plugins: 2 },
    ])
  })

  test("shows both local and global scoped marketplaces with correct labels", async () => {
    await using tmp = await tmpdir()
    const localCfg = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(localCfg), { recursive: true })
    await Bun.write(localCfg, JSON.stringify({ marketplace: ["local/repo"] }, null, 2))

    const globalDir = path.join(tmp.path, "global")
    const globalCfg = path.join(globalDir, "opencode.json")
    await fs.mkdir(globalDir, { recursive: true })
    await Bun.write(globalCfg, JSON.stringify({ marketplace: ["global/repo"] }, null, 2))

    const entries = await listMarketplaces(
      ctx(tmp.path),
      listDeps(globalDir, {
        fetchText: async (url) => {
          if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
          return JSON.stringify(validManifest)
        },
        readText: async () => "",
        stat: async () => undefined,
      }),
    )

    expect(entries).toEqual([
      { scope: "local", source: "local/repo", name: "lunos-community", plugins: 2 },
      { scope: "global", source: "global/repo", name: "lunos-community", plugins: 2 },
    ])
  })

  test("degrades gracefully for an unreachable marketplace", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/does-not-exist"] }, null, 2))

    const entries = await listMarketplaces(
      ctx(tmp.path),
      listDeps(path.join(tmp.path, "global"), {
        fetchText: async () => {
          throw new Error("404")
        },
        readText: async () => "",
        stat: async () => undefined,
      }),
    )

    expect(entries.length).toBe(1)
    expect(entries[0].source).toBe("pminev1/does-not-exist")
    expect(entries[0].error).toContain("404")
    expect(entries[0].plugins).toBeUndefined()
  })
})
