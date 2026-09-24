import { describe, expect, test } from "bun:test"
import { entryMeta, platformMeta, REPOSITORY_URL } from "../../script/package-meta"

describe("published npm metadata", () => {
  test("lunos-ai carries description, homepage, repository, bugs, author, keywords, license", () => {
    const meta = entryMeta()
    expect(meta.description).toContain("Lunos")
    expect(meta.homepage).toBe("https://lunos.tech")
    expect(meta.repository.url).toBe("git+https://github.com/AxsionDev/Lunos.git")
    expect(meta.bugs.url).toBe("https://github.com/AxsionDev/Lunos/issues")
    expect(meta.author).toContain("ITService EOOD")
    expect(meta.license).toBe("MIT")
    expect(meta.keywords).toContain("lunos")
  })

  test("platform packages name their platform and point at the same repository", () => {
    const meta = platformMeta("linux-x64-musl")
    expect(meta.description).toContain("linux-x64-musl")
    expect(meta.repository.url).toBe(entryMeta().repository.url)
    expect(meta.license).toBe("MIT")
  })

  // npm rejects a --provenance publish whose package.json repository doesn't match the
  // GitHub repo the workflow ran in.
  test("the repository matches the repo publish.yml runs in", async () => {
    const root = await Bun.file(new URL("../../../../package.json", import.meta.url)).json()
    expect(root.homepage).toBe(REPOSITORY_URL)
  })

  test("the npm README exists and names the install command", async () => {
    const readme = await Bun.file(new URL("../../script/npm-readme.md", import.meta.url)).text()
    expect(readme).toContain("npm i -g lunos-ai")
    expect(readme).toContain("self-hosted.md")
  })
})
