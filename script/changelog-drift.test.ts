import { describe, expect, test } from "bun:test"
import path from "path"
import { check, compare, newestInChangelog, newestOnSite } from "./changelog-drift"

// The site's markup as of 2026-10-19: a tag link per version, plus version numbers in the text.
const page = (...versions: string[]) =>
  versions
    .map(
      (v) =>
        `<h2 id="${v}"><a href="https://github.com/AxsionDev/Lunos/releases/tag/v${v}">v${v}</a></h2>` +
        `<p>Fixed in v9.9.9; needs Bun 1.3.14.</p>`,
    )
    .join("\n")

const site = (body: string, status = 200) => {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return new Response(body, { status })
  }
  return { fetch, calls }
}

describe("changelog-drift", () => {
  test("compares versions numerically", () => {
    expect(compare("1.18.50", "1.18.9")).toBeGreaterThan(0)
    expect(compare("1.18.9", "1.18.50")).toBeLessThan(0)
    expect(compare("2.0.0", "2.0.0")).toBe(0)
  })

  test("the site's newest version comes from release tag links only, not from version numbers in the text", () => {
    expect(newestOnSite(page("1.18.46", "1.18.44", "1.18.9"))).toBe("1.18.46")
    expect(newestOnSite("<p>Lunos v1.18.50 is out</p>")).toBeUndefined()
  })

  test("the newest CHANGELOG version skips [Unreleased]", () => {
    expect(newestInChangelog("## [Unreleased]\n\n- x\n\n## [1.18.50] - 2026-10-19\n\n- y\n")).toBe("1.18.50")
  })

  test("the built-in CHANGELOG has a newest version", async () => {
    const text = await Bun.file(path.join(import.meta.dir, "..", "CHANGELOG.md")).text()
    expect(newestInChangelog(text)).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("fails when the site is behind", async () => {
    const { fetch, calls } = site(page("1.18.46", "1.18.44"))
    const result = await check({ url: "https://lunos.tech/changelog", expected: "v1.18.50", fetch })
    expect(result).toEqual({ status: "behind", site: "1.18.46", expected: "1.18.50" })
    expect(calls).toEqual(["https://lunos.tech/changelog"])
  })

  test("passes when the site is current", async () => {
    const { fetch } = site(page("1.18.50", "1.18.49"))
    expect(await check({ url: "u", expected: "1.18.50", fetch })).toEqual({
      status: "current",
      site: "1.18.50",
      expected: "1.18.50",
    })
  })

  test("a site ahead of the expected version is not a failure", async () => {
    const { fetch } = site(page("1.18.51"))
    expect((await check({ url: "u", expected: "1.18.50", fetch })).status).toBe("ahead")
  })

  test("behind within the grace period after the release only warns; after it, fails", async () => {
    const { fetch } = site(page("1.18.49"))
    const publishedAt = "2026-10-19T12:00:00Z"
    const at = (iso: string) => check({ url: "u", expected: "1.18.50", publishedAt, now: Date.parse(iso), fetch })
    expect((await at("2026-10-19T12:59:00Z")).status).toBe("grace")
    expect((await at("2026-10-19T13:01:00Z")).status).toBe("behind")
  })

  test("a page that links no versions is an error, never a pass", async () => {
    const { fetch } = site("<html><body>Loading…</body></html>")
    expect((await check({ url: "u", expected: "1.18.50", fetch })).status).toBe("error")
  })

  test("an HTTP error or a network failure is an error", async () => {
    expect((await check({ url: "u", expected: "1.18.50", fetch: site("gone", 503).fetch })).status).toBe("error")
    const down = async () => {
      throw new Error("connect ECONNREFUSED")
    }
    expect(await check({ url: "u", expected: "1.18.50", fetch: down })).toEqual({
      status: "error",
      message: "u: connect ECONNREFUSED",
    })
  })
})
