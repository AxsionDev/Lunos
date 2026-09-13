import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { sourceKind, resolveMarketplaceManifest, defaultFetchDeps, type FetchDeps } from "../../src/marketplace/shared"
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
