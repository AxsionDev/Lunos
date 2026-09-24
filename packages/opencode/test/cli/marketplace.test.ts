import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import {
  createMarketplaceAddTask,
  createMarketplaceUpdateTask,
  listMarketplaces,
  type MarketplaceDeps,
} from "../../src/cli/cmd/marketplace"
import type { FetchDeps, MarketplaceCacheDeps, MarketplaceCtx, MarketplaceListDeps } from "../../src/marketplace/shared"
import { DEFAULT_MARKETPLACE } from "../../src/marketplace/shared"
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
    cache: testCacheDeps(path.join(global, "..", "cache")),
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

  test("seeds the cache so the very next list is served from cache, not a second fetch", async () => {
    await using tmp = await tmpdir()
    const global = path.join(tmp.path, "global")

    const run = createMarketplaceAddTask(
      { source: "pminev1/Lunos" },
      addDeps(global, async () => validManifest as never),
    )
    expect(await run(ctx(tmp.path))).toBe(true)

    const entries = await listMarketplaces(
      ctx(tmp.path),
      listDeps(global, {
        fetchText: async () => {
          throw new Error("should not be called: list should be served from the cache add() seeded")
        },
        readText: async () => "",
        stat: async () => undefined,
      }),
    )

    expect(entries).toEqual([
      {
        scope: "local",
        source: "pminev1/Lunos",
        name: "lunos-community",
        contents: "2 plugin(s)",
        fetchedAt: expect.any(Number),
      },
    ])
  })
})

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

describe("marketplace.list", () => {
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

  test("counts MCP servers, skills and hooks, not just plugins", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))
    const mcpOnly = {
      name: "mcp-only",
      owner: { name: "x" },
      plugins: [],
      mcp: [{ name: "a", type: "remote", url: "https://example.test/mcp" }],
      hooks: [{ name: "h", event: "session.idle", command: ["true"] }],
    }

    const entries = await listMarketplaces(
      ctx(tmp.path),
      listDeps(path.join(tmp.path, "global"), {
        fetchText: async (url) =>
          url.includes("api.github.com") ? JSON.stringify({ default_branch: "dev" }) : JSON.stringify(mcpOnly),
        readText: async () => "",
        stat: async () => undefined,
      }),
    )

    expect(entries[0].contents).toBe("1 hook(s), 1 MCP server(s)")
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
      {
        scope: "local",
        source: "pminev1/Lunos",
        name: "lunos-community",
        contents: "2 plugin(s)",
        fetchedAt: expect.any(Number),
      },
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
      {
        scope: "local",
        source: "local/repo",
        name: "lunos-community",
        contents: "2 plugin(s)",
        fetchedAt: expect.any(Number),
      },
      {
        scope: "global",
        source: "global/repo",
        name: "lunos-community",
        contents: "2 plugin(s)",
        fetchedAt: expect.any(Number),
      },
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
    expect(entries[0].contents).toBeUndefined()
  })

  test("reads from cache on a second call instead of fetching again", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))

    let fetches = 0
    const deps = listDeps(path.join(tmp.path, "global"), {
      fetchText: async (url) => {
        fetches++
        if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
        return JSON.stringify(validManifest)
      },
      readText: async () => "",
      stat: async () => undefined,
    })

    await listMarketplaces(ctx(tmp.path), deps)
    expect(fetches).toBe(2) // default-branch lookup + manifest fetch

    const entries = await listMarketplaces(ctx(tmp.path), deps)
    expect(fetches).toBe(2) // unchanged: second call served entirely from cache
    expect(entries).toEqual([
      {
        scope: "local",
        source: "pminev1/Lunos",
        name: "lunos-community",
        contents: "2 plugin(s)",
        fetchedAt: expect.any(Number),
      },
    ])
  })

  test("falls back to the last-known-good cache when a previously-cached source goes unreachable", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))

    // listDeps() points cache at path.join(tmp.path, "cache") for both deps below.
    const cacheDir = path.join(tmp.path, "cache")
    const okDeps = listDeps(path.join(tmp.path, "global"), {
      fetchText: async (url) => {
        if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
        return JSON.stringify(validManifest)
      },
      readText: async () => "",
      stat: async () => undefined,
    })
    await listMarketplaces(ctx(tmp.path), okDeps)

    // Force the cache to look expired so the next read attempts (and fails) a live refresh.
    const [cacheEntry] = await fs.readdir(cacheDir)
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.utimes(path.join(cacheDir, cacheEntry!), stale, stale)

    const failingDeps = listDeps(path.join(tmp.path, "global"), {
      fetchText: async () => {
        throw new Error("network unreachable")
      },
      readText: async () => "",
      stat: async () => undefined,
    })

    const entries = await listMarketplaces(ctx(tmp.path), failingDeps)
    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe("lunos-community")
    expect(entries[0].contents).toBe("2 plugin(s)")
    expect(entries[0].stale).toContain("network unreachable")
  })
})

describe("marketplace.update.task", () => {
  function logSpy() {
    const messages: string[] = []
    return {
      log: {
        error: (msg: string) => messages.push(`error: ${msg}`),
        info: (msg: string) => messages.push(`info: ${msg}`),
        success: (msg: string) => messages.push(`success: ${msg}`),
      },
      messages,
    }
  }

  function updateDeps(log: MarketplaceDeps["log"]): MarketplaceDeps {
    return {
      spinner: () => ({ start() {}, stop() {} }),
      log,
      resolve: () => {
        throw new Error("not used by the update task")
      },
      readText: (file) => Filesystem.readText(file),
      write: async (file, text) => {
        await Filesystem.write(file, text)
      },
      exists: (file) => Filesystem.exists(file),
      files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
      global: "/unused-global",
      cache: testCacheDeps("/unused-cache"),
    }
  }

  test("matches by declared name and forces a re-fetch bypassing the cache", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))

    let fetches = 0
    const listDep = listDeps(path.join(tmp.path, "global"), {
      fetchText: async (url) => {
        fetches++
        if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
        return JSON.stringify(validManifest)
      },
      readText: async () => "",
      stat: async () => undefined,
    })

    await listMarketplaces(ctx(tmp.path), listDep) // populates the cache
    expect(fetches).toBe(2)

    const { log, messages } = logSpy()
    const run = createMarketplaceUpdateTask({ name: "lunos-community" }, updateDeps(log), listDep)
    const ok = await run(ctx(tmp.path))

    expect(ok).toBe(true)
    expect(fetches).toBe(4) // update bypasses the TTL: default-branch lookup + manifest fetch again
    expect(messages.some((m) => m.startsWith("success:"))).toBe(true)
  })

  test("reports no match without touching the cache when the name is unknown", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))

    const listDep = listDeps(path.join(tmp.path, "global"), {
      fetchText: async () => {
        throw new Error("should not be called")
      },
      readText: async () => "",
      stat: async () => undefined,
    })

    const { log, messages } = logSpy()
    const run = createMarketplaceUpdateTask({ name: "does-not-exist" }, updateDeps(log), listDep)
    const ok = await run(ctx(tmp.path))

    expect(ok).toBe(false)
    expect(messages).toEqual([`error: No added marketplace matches "does-not-exist"`])
  })

  test("keeps serving the last-known-good manifest and reports the failure when the re-fetch fails", async () => {
    await using tmp = await tmpdir()
    const cfgFile = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfgFile), { recursive: true })
    await Bun.write(cfgFile, JSON.stringify({ marketplace: ["pminev1/Lunos"] }, null, 2))

    const okListDep = listDeps(path.join(tmp.path, "global"), {
      fetchText: async (url) => {
        if (url.includes("api.github.com")) return JSON.stringify({ default_branch: "dev" })
        return JSON.stringify(validManifest)
      },
      readText: async () => "",
      stat: async () => undefined,
    })
    await listMarketplaces(ctx(tmp.path), okListDep)

    const failingListDep = listDeps(path.join(tmp.path, "global"), {
      fetchText: async () => {
        throw new Error("network unreachable")
      },
      readText: async () => "",
      stat: async () => undefined,
    })

    const { log, messages } = logSpy()
    const run = createMarketplaceUpdateTask({ name: "pminev1/Lunos" }, updateDeps(log), failingListDep)
    const ok = await run(ctx(tmp.path))

    expect(ok).toBe(false)
    expect(messages.some((m) => m.includes("network unreachable"))).toBe(true)
    expect(messages.some((m) => m.includes("Still serving the cached copy"))).toBe(true)

    // The cache itself was left untouched by the failed refresh, so a plain (still-fresh, no
    // live-check) list right after continues to serve the same last-known-good manifest.
    const entries = await listMarketplaces(ctx(tmp.path), failingListDep)
    expect(entries[0]?.name).toBe("lunos-community")
  })
})

describe("marketplace.builtin (XCOD-88)", () => {
  const builtinFetch = (calls: string[]): FetchDeps => ({
    fetchText: async (url) => {
      calls.push(url)
      return JSON.stringify(validManifest)
    },
    readText: async () => "",
    stat: async () => undefined,
  })

  test("a fresh install with no config lists lunos-community as a built-in marketplace", async () => {
    await using tmp = await tmpdir()
    const calls: string[] = []
    const entries = await listMarketplaces(ctx(tmp.path), {
      ...listDeps(path.join(tmp.path, "global"), builtinFetch(calls)),
      builtin: DEFAULT_MARKETPLACE,
    })
    expect(entries).toEqual([
      expect.objectContaining({ scope: "builtin", source: DEFAULT_MARKETPLACE, name: "lunos-community" }),
    ])
    expect(calls).toEqual([DEFAULT_MARKETPLACE])
  })

  test('"marketplace_default": false in any config layer turns it off without fetching', async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global")
    await fs.mkdir(globalDir, { recursive: true })
    await Bun.write(path.join(globalDir, "opencode.json"), JSON.stringify({ marketplace_default: false }))
    const calls: string[] = []
    const entries = await listMarketplaces(ctx(tmp.path), {
      ...listDeps(globalDir, builtinFetch(calls)),
      builtin: DEFAULT_MARKETPLACE,
    })
    expect(entries).toEqual([])
    expect(calls).toEqual([])
  })

  test("isn't listed twice when the user has already added the same source", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global")
    await fs.mkdir(globalDir, { recursive: true })
    await Bun.write(path.join(globalDir, "opencode.json"), JSON.stringify({ marketplace: [DEFAULT_MARKETPLACE] }))
    const entries = await listMarketplaces(ctx(tmp.path), {
      ...listDeps(globalDir, builtinFetch([])),
      builtin: DEFAULT_MARKETPLACE,
    })
    expect(entries.map((entry) => entry.scope)).toEqual(["global"])
  })
})
