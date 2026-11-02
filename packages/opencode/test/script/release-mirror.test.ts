import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { mkdtemp, readdir, readFile, rm, stat } from "fs/promises"
import os from "os"
import path from "path"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { Effect } from "effect"
import { mirrorRelease, parseSums, wanted, writeIndex, type Fetcher } from "../../script/release-mirror"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), "lunos-mirror-"))
  dirs.push(d)
  return d
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

/** A GitHub release on a fake API: no network. `tamper` serves different bytes for one asset. */
function fakeGitHub(
  files: Record<string, string>,
  opts: { tamper?: string; omitFromSums?: string; draft?: boolean } = {},
) {
  const sums = Object.entries(files)
    .filter(([name]) => name !== opts.omitFromSums)
    .map(([name, body]) => `${sha(body)}  ${name}\n`)
    .join("")
  const all = { ...files, SHA256SUMS: sums, "SHA256SUMS.sigstore.json": "{}" }
  const downloads: string[] = []
  const fetcher: Fetcher = async (url) => {
    if (url.startsWith("https://api.test/repos/AxsionDev/Lunos/releases/tags/"))
      return Response.json({
        tag_name: "v1.19.2",
        draft: !!opts.draft,
        published_at: "2026-11-01T10:00:00Z",
        assets: Object.entries(all).map(([name, body]) => ({
          name,
          size: body.length,
          browser_download_url: `https://dl.test/${name}`,
        })),
      })
    const name = url.replace("https://dl.test/", "")
    downloads.push(name)
    if (!(name in all)) return new Response("missing", { status: 404 })
    return new Response(name === opts.tamper ? "evil bytes" : all[name as keyof typeof all])
  }
  return { fetcher, downloads }
}

const ASSETS = {
  "lunos-offline-linux-x64.tar.gz": "offline bundle bytes",
  "lunos-linux-x64.tar.gz": "archive bytes",
  "lunos-sbom-1.19.2.cdx.json": '{"bomFormat":"CycloneDX"}',
}

describe("release mirror (XCOD-193)", () => {
  test("mirrors a release, verified against SHA256SUMS, and indexes it; a second run downloads only SHA256SUMS", async () => {
    const out = await tmp()
    const gh = fakeGitHub(ASSETS)
    const release = await mirrorRelease({
      repo: "AxsionDev/Lunos",
      tag: "v1.19.2",
      out,
      fetcher: gh.fetcher,
      api: "https://api.test",
      log: () => {},
    })
    expect(release.assets.map((a) => a.name).sort()).toEqual(Object.keys(ASSETS).sort())
    for (const a of release.assets) expect(a.sha256).toBe(sha(ASSETS[a.name as keyof typeof ASSETS]))
    expect((await readdir(path.join(out, "v1.19.2"))).sort()).toEqual(
      [...Object.keys(ASSETS), "SHA256SUMS", "SHA256SUMS.sigstore.json"].sort(),
    )
    const index = await writeIndex(out, "AxsionDev/Lunos", [release])
    expect(index[0]).toMatchObject({ tag: "v1.19.2", publishedAt: "2026-11-01T10:00:00Z" })
    expect(JSON.parse(await readFile(path.join(out, "index.json"), "utf8")).releases).toHaveLength(1)

    gh.downloads.length = 0
    await mirrorRelease({
      repo: "AxsionDev/Lunos",
      tag: "v1.19.2",
      out,
      fetcher: gh.fetcher,
      api: "https://api.test",
      log: () => {},
    })
    expect(gh.downloads.sort()).toEqual(["SHA256SUMS", "SHA256SUMS.sigstore.json"])
  })

  test("an asset that doesn't match SHA256SUMS is refused and not kept", async () => {
    const out = await tmp()
    const gh = fakeGitHub(ASSETS, { tamper: "lunos-linux-x64.tar.gz" })
    await expect(
      mirrorRelease({
        repo: "AxsionDev/Lunos",
        tag: "v1.19.2",
        out,
        fetcher: gh.fetcher,
        api: "https://api.test",
        log: () => {},
      }),
    ).rejects.toThrow("doesn't match SHA256SUMS")
    expect(await stat(path.join(out, "v1.19.2", "lunos-linux-x64.tar.gz")).catch(() => undefined)).toBeUndefined()
  })

  test("an asset missing from SHA256SUMS, a draft, or a bad tag is refused", async () => {
    const out = await tmp()
    await expect(
      mirrorRelease({
        repo: "AxsionDev/Lunos",
        tag: "v1.19.2",
        out,
        fetcher: fakeGitHub(ASSETS, { omitFromSums: "lunos-linux-x64.tar.gz" }).fetcher,
        api: "https://api.test",
        log: () => {},
      }),
    ).rejects.toThrow("isn't in v1.19.2's SHA256SUMS")
    await expect(
      mirrorRelease({
        repo: "AxsionDev/Lunos",
        tag: "v1.19.2",
        out,
        fetcher: fakeGitHub(ASSETS, { draft: true }).fetcher,
        api: "https://api.test",
        log: () => {},
      }),
    ).rejects.toThrow("draft")
    await expect(
      mirrorRelease({
        repo: "AxsionDev/Lunos",
        tag: "../etc",
        out,
        fetcher: fakeGitHub(ASSETS).fetcher,
        api: "https://api.test",
        log: () => {},
      }),
    ).rejects.toThrow("not a release tag")
  })

  test("patterns choose assets; SHA256SUMS always comes; the signature check runs before anything else is trusted", async () => {
    const out = await tmp()
    const gh = fakeGitHub(ASSETS)
    const order: string[] = []
    const release = await mirrorRelease({
      repo: "AxsionDev/Lunos",
      tag: "v1.19.2",
      out,
      fetcher: async (url, init) => {
        order.push(url.split("/").at(-1)!)
        return gh.fetcher(url, init)
      },
      api: "https://api.test",
      patterns: ["lunos-offline-*"],
      verifySignature: async () => {
        order.push("verify")
      },
      log: () => {},
    })
    expect(release.assets.map((a) => a.name)).toEqual(["lunos-offline-linux-x64.tar.gz"])
    expect(order.indexOf("verify")).toBeLessThan(order.indexOf("lunos-offline-linux-x64.tar.gz"))
    expect(order.indexOf("verify")).toBeGreaterThan(order.indexOf("SHA256SUMS"))
    expect(wanted("SHA256SUMS", ["x"])).toBe(true)
    expect(parseSums(`${"a".repeat(64)}  a.zip\n${"b".repeat(64)} *b.zip\nnot a line\n`)).toEqual(
      new Map([
        ["a.zip", "a".repeat(64)],
        ["b.zip", "b".repeat(64)],
      ]),
    )
  })

  test("the update check and `lunos update` read the npm registry from npm's own configuration: a registry mirror needs no Lunos setting", async () => {
    const dir = await tmp()
    await Bun.write(path.join(dir, ".npmrc"), "registry=https://npm.mirror.corp.example/repository/npm/\n")
    expect(await Effect.runPromise(NpmConfig.registry(dir))).toBe("https://npm.mirror.corp.example/repository/npm")
  })
})
