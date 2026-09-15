import { describe, expect, test } from "bun:test"
import type { ResolveDeps } from "./resolve"
import { resolveSource } from "./resolve"

/** Minimal valid manifest JSON, matching `Marketplace.Manifest`'s encoded shape. */
const validManifest = {
  name: "synthetic-marketplace",
  owner: { name: "Synthetic Owner" },
  plugins: [],
}

function fakeFetch(responses: Record<string, string | Error>): ResolveDeps {
  return {
    async fetchText(url) {
      const response = responses[url]
      if (response === undefined) throw new Error(`unexpected fetch: ${url}`)
      if (response instanceof Error) throw response
      return response
    },
  }
}

describe("resolveSource", () => {
  test("a direct URL is fetched and decoded as-is", async () => {
    const dep = fakeFetch({ "https://example.com/marketplace.json": JSON.stringify(validManifest) })

    const manifest = await resolveSource("https://example.com/marketplace.json", dep)

    expect(manifest).toEqual(validManifest)
  })

  test("a bare 'owner/repo' shorthand resolves the default branch, then fetches raw content", async () => {
    const dep = fakeFetch({
      "https://api.github.com/repos/pminev1/Lunos": JSON.stringify({ default_branch: "main" }),
      "https://raw.githubusercontent.com/pminev1/Lunos/main/marketplace.json": JSON.stringify(validManifest),
    })

    const manifest = await resolveSource("pminev1/Lunos", dep)

    expect(manifest).toEqual(validManifest)
  })

  test("a non-ok HTTP response surfaces the status in the error", async () => {
    const dep: ResolveDeps = {
      async fetchText(url) {
        throw new Error(`Request to ${url} failed with status 404`)
      },
    }

    await expect(resolveSource("https://example.com/gone.json", dep)).rejects.toThrow("status 404")
  })

  test("a GitHub repo with no discoverable default branch fails clearly", async () => {
    const dep = fakeFetch({ "https://api.github.com/repos/pminev1/empty": JSON.stringify({}) })

    await expect(resolveSource("pminev1/empty", dep)).rejects.toThrow("Could not determine the default branch")
  })

  test("malformed JSON fails clearly rather than throwing a bare SyntaxError context-free", async () => {
    const dep = fakeFetch({ "https://example.com/broken.json": "not json" })

    await expect(resolveSource("https://example.com/broken.json", dep)).rejects.toThrow()
  })

  test("JSON that fails schema validation is rejected, not silently coerced", async () => {
    const dep = fakeFetch({ "https://example.com/invalid.json": JSON.stringify({ name: "missing-owner" }) })

    await expect(resolveSource("https://example.com/invalid.json", dep)).rejects.toThrow()
  })
})
