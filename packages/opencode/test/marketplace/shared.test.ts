import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import {
  sourceKind,
  resolveMarketplaceManifest,
  resolveAddedMarketplaces,
  refreshMarketplaceCache,
  defaultFetchDeps,
  type FetchDeps,
  type MarketplaceCacheDeps,
  type MarketplaceCtx,
  type MarketplaceListDeps,
} from "../../src/marketplace/shared"
import { tmpdir } from "../fixture/fixture"

const validManifest = {
  name: "lunos-community",
  owner: { name: "Lunos Community" },
  plugins: [
    {
      name: "conventional-commits",
      source: { type: "npm", package: "@lunos-community/conventional-commits" },
    },
  ],
}

function deps(overrides: Partial<FetchDeps> = {}): FetchDeps {
  return {
    fetchText: async () => {
      throw new Error("fetchText not stubbed")
    },
    readText: async () => {
      throw new Error("readText not stubbed")
    },
    stat: async () => undefined,
    ...overrides,
  }
}

describe("marketplace.shared.sourceKind", () => {
  test("classifies a URL", () => {
    expect(sourceKind("https://example.com/marketplace.json")).toBe("url")
  })

  test("classifies a relative path", () => {
    expect(sourceKind("./local-marketplace")).toBe("path")
  })

  test("classifies an absolute path", () => {
    expect(sourceKind("/tmp/local-marketplace")).toBe("path")
  })

  test("classifies a file:// URL", () => {
    expect(sourceKind("file:///tmp/local-marketplace")).toBe("path")
  })

  test("classifies owner/repo shorthand as github", () => {
    expect(sourceKind("pminev1/Lunos")).toBe("github")
  })
})

describe("marketplace.shared.resolveMarketplaceManifest", () => {
  test("resolves a direct URL", async () => {
    const manifest = await resolveMarketplaceManifest(
      "https://example.com/marketplace.json",
      deps({
        fetchText: async (url) => {
          expect(url).toBe("https://example.com/marketplace.json")
          return JSON.stringify(validManifest)
        },
      }),
    )
    expect(manifest.name).toBe("lunos-community")
    expect(manifest.plugins.length).toBe(1)
  })

  test("resolves github owner/repo via default branch lookup", async () => {
    const calls: string[] = []
    const manifest = await resolveMarketplaceManifest(
      "pminev1/Lunos",
      deps({
        fetchText: async (url) => {
          calls.push(url)
          if (url === "https://api.github.com/repos/pminev1/Lunos") {
            return JSON.stringify({ default_branch: "dev" })
          }
          if (url === "https://raw.githubusercontent.com/pminev1/Lunos/dev/marketplace.json") {
            return JSON.stringify(validManifest)
          }
          throw new Error(`unexpected url ${url}`)
        },
      }),
    )
    expect(calls).toEqual([
      "https://api.github.com/repos/pminev1/Lunos",
      "https://raw.githubusercontent.com/pminev1/Lunos/dev/marketplace.json",
    ])
    expect(manifest.name).toBe("lunos-community")
  })

  test("rejects invalid github shorthand", async () => {
    await expect(resolveMarketplaceManifest("not-a-valid-repo-spec/", deps())).rejects.toThrow()
  })

  test("propagates a clear error when the github repo cannot be resolved", async () => {
    await expect(
      resolveMarketplaceManifest(
        "pminev1/does-not-exist",
        deps({
          fetchText: async () => {
            throw new Error("Request to https://api.github.com/repos/pminev1/does-not-exist failed with status 404")
          },
        }),
      ),
    ).rejects.toThrow(/404/)
  })

  test("resolves a local directory containing marketplace.json", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "marketplace.json"), JSON.stringify(validManifest))
    const manifest = await resolveMarketplaceManifest(tmp.path, defaultFetchDeps)
    expect(manifest.name).toBe("lunos-community")
  })

  test("resolves a local file path directly", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "custom-manifest.json")
    await fs.writeFile(file, JSON.stringify(validManifest))
    const manifest = await resolveMarketplaceManifest(file, defaultFetchDeps)
    expect(manifest.name).toBe("lunos-community")
  })

  test("rejects a manifest that fails schema validation", async () => {
    await expect(
      resolveMarketplaceManifest(
        "https://example.com/marketplace.json",
        deps({
          fetchText: async () =>
            JSON.stringify({
              name: "bad",
              owner: { name: "x" },
              plugins: [{ name: "y", source: { type: "archive", url: "https://example.com/y.tar.gz" } }],
            }),
        }),
      ),
    ).rejects.toThrow()
  })
})

describe("marketplace.shared.cache", () => {
  function cacheDeps(dir: string): MarketplaceCacheDeps {
    return {
      dir,
      mtime: async (file) => {
        const stat = await fs.stat(file).catch(() => undefined)
        return stat ? stat.mtimeMs : undefined
      },
      readText: (file) => fs.readFile(file, "utf8").catch(() => undefined),
      write: async (file, text) => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, text)
      },
    }
  }

  function listDeps(cacheDir: string, resolve: FetchDeps, global = "/unused-global"): MarketplaceListDeps {
    return {
      exists: (file) =>
        fs
          .access(file)
          .then(() => true)
          .catch(() => false),
      readText: (file) => fs.readFile(file, "utf8"),
      files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
      resolve,
      global,
      cache: cacheDeps(cacheDir),
    }
  }

  async function addSource(worktree: string, source: string) {
    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(worktree, ".opencode", "opencode.json"),
      JSON.stringify({ marketplace: [source] }, null, 2),
    )
  }

  function ctx(dir: string): MarketplaceCtx {
    return { vcs: "git", worktree: dir, directory: dir }
  }

  test("writes the manifest to disk after the first successful fetch", async () => {
    await using tmp = await tmpdir()
    await addSource(tmp.path, "https://example.com/marketplace.json")
    const cacheDir = path.join(tmp.path, "cache")

    await resolveAddedMarketplaces(
      ctx(tmp.path),
      listDeps(cacheDir, { ...defaultFetchDeps, fetchText: async () => JSON.stringify(validManifest) }),
    )

    const files = await fs.readdir(cacheDir)
    expect(files.length).toBe(1)
  })

  test("a second resolve reads from cache instead of fetching again", async () => {
    await using tmp = await tmpdir()
    await addSource(tmp.path, "https://example.com/marketplace.json")
    const cacheDir = path.join(tmp.path, "cache")

    let fetches = 0
    const deps = listDeps(cacheDir, {
      ...defaultFetchDeps,
      fetchText: async () => {
        fetches++
        return JSON.stringify(validManifest)
      },
    })

    await resolveAddedMarketplaces(ctx(tmp.path), deps)
    expect(fetches).toBe(1)

    const [entry] = await resolveAddedMarketplaces(ctx(tmp.path), deps)
    expect(fetches).toBe(1)
    expect(entry).toMatchObject({ ok: true, source: "https://example.com/marketplace.json" })
  })

  test("falls back to the stale cache when a refresh attempt fails, with the error visible", async () => {
    await using tmp = await tmpdir()
    await addSource(tmp.path, "https://example.com/marketplace.json")
    const cacheDir = path.join(tmp.path, "cache")

    const okDeps = listDeps(cacheDir, { ...defaultFetchDeps, fetchText: async () => JSON.stringify(validManifest) })
    await resolveAddedMarketplaces(ctx(tmp.path), okDeps)

    // Age the cache file past the TTL so the next resolve attempts (and fails) a live refresh.
    const [file] = await fs.readdir(cacheDir)
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.utimes(path.join(cacheDir, file!), expired, expired)

    const failingDeps = listDeps(cacheDir, {
      ...defaultFetchDeps,
      fetchText: async () => {
        throw new Error("network unreachable")
      },
    })
    const [entry] = await resolveAddedMarketplaces(ctx(tmp.path), failingDeps)

    expect(entry?.ok).toBe(true)
    if (entry?.ok) {
      expect(entry.manifest.name).toBe("lunos-community")
      expect(entry.stale).toContain("network unreachable")
    }
  })

  test("fails with no fallback when a source has never been cached", async () => {
    await using tmp = await tmpdir()
    await addSource(tmp.path, "https://example.com/marketplace.json")
    const cacheDir = path.join(tmp.path, "cache")

    const [entry] = await resolveAddedMarketplaces(
      ctx(tmp.path),
      listDeps(cacheDir, {
        ...defaultFetchDeps,
        fetchText: async () => {
          throw new Error("404")
        },
      }),
    )

    expect(entry).toEqual({
      scope: "local",
      source: "https://example.com/marketplace.json",
      ok: false,
      error: expect.stringContaining("404"),
    })
  })

  test("refreshMarketplaceCache forces a live fetch even when the cache is still fresh", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    const source = "https://example.com/marketplace.json"

    let fetches = 0
    const deps = listDeps(cacheDir, {
      ...defaultFetchDeps,
      fetchText: async () => {
        fetches++
        return JSON.stringify(validManifest)
      },
    })

    const first = await refreshMarketplaceCache(source, deps)
    expect(first.ok).toBe(true)
    expect(fetches).toBe(1)

    const second = await refreshMarketplaceCache(source, deps)
    expect(second.ok).toBe(true)
    expect(fetches).toBe(2) // forced: no TTL short-circuit, unlike resolveAddedMarketplaces
  })

  test("refreshMarketplaceCache keeps the last-known-good manifest when the re-fetch fails", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    const source = "https://example.com/marketplace.json"

    await refreshMarketplaceCache(
      source,
      listDeps(cacheDir, { ...defaultFetchDeps, fetchText: async () => JSON.stringify(validManifest) }),
    )

    const result = await refreshMarketplaceCache(
      source,
      listDeps(cacheDir, {
        ...defaultFetchDeps,
        fetchText: async () => {
          throw new Error("timeout")
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("timeout")
      expect(result.fetchedAt).toBeDefined()
    }

    // The on-disk cache itself was left untouched by the failed refresh — still the prior manifest.
    const cache = cacheDeps(cacheDir)
    const files = await fs.readdir(cacheDir)
    const text = await cache.readText(path.join(cacheDir, files[0]!))
    expect(JSON.parse(text!).name).toBe("lunos-community")
  })

  test("local path sources bypass the cache entirely and are always read live", async () => {
    await using tmp = await tmpdir()
    const marketplaceDir = path.join(tmp.path, "local-marketplace")
    await fs.mkdir(marketplaceDir, { recursive: true })
    await fs.writeFile(path.join(marketplaceDir, "marketplace.json"), JSON.stringify(validManifest))
    await addSource(tmp.path, marketplaceDir)

    const cacheDir = path.join(tmp.path, "cache")
    const deps = listDeps(cacheDir, defaultFetchDeps)

    const [first] = await resolveAddedMarketplaces(ctx(tmp.path), deps)
    expect(first).toMatchObject({ ok: true, manifest: { name: "lunos-community" } })
    expect(await fs.readdir(cacheDir).catch(() => [])).toEqual([]) // nothing written to the cache

    // Edit the manifest on disk between calls — a cached source would still show the old data.
    await fs.writeFile(
      path.join(marketplaceDir, "marketplace.json"),
      JSON.stringify({ ...validManifest, name: "edited-locally" }),
    )
    const [second] = await resolveAddedMarketplaces(ctx(tmp.path), deps)
    expect(second).toMatchObject({ ok: true, manifest: { name: "edited-locally" } })
  })
})
