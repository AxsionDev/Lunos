import { describe, expect, test } from "bun:test"
import { runIngestion, type SourceResolution } from "./ingest"
import type { IngestionSourceDb, ManifestJson, RegistryWriteDb } from "./db"

/** Same DI-fake convention as `seed.test.ts`'s `fakeWriteDb`: a `RegistryWriteDb` that
 * records every call instead of touching D1, so a test can assert both what was written
 * and — just as important here — what was NOT. */
function fakeWriteDb() {
  const calls: { readonly manifest: ManifestJson; readonly source: string }[] = []
  const db: RegistryWriteDb = {
    async replaceMarketplace(input) {
      calls.push(input)
    },
  }
  return { calls, db }
}

function fakeSourceDb(sources: readonly string[]): IngestionSourceDb {
  return { async listMarketplaceSources() { return [...sources] } }
}

function manifest(name: string): ManifestJson {
  return { name, owner: { name: `${name} owner` }, plugins: [] }
}

describe("runIngestion", () => {
  test("resolves every registered source and writes each one", async () => {
    const { calls, db } = fakeWriteDb()

    const result = await runIngestion({
      sources: fakeSourceDb(["source-a", "source-b"]),
      write: db,
      resolve: async (source) => manifest(source),
      log: () => {},
    })

    expect(calls).toEqual([
      { manifest: manifest("source-a"), source: "source-a" },
      { manifest: manifest("source-b"), source: "source-b" },
    ])
    expect(result.resolutions).toEqual([
      { source: "source-a", ok: true, manifest: manifest("source-a") },
      { source: "source-b", ok: true, manifest: manifest("source-b") },
    ])
  })

  test("a resolve failure is isolated: no write for that source, other sources unaffected", async () => {
    const { calls, db } = fakeWriteDb()

    const result = await runIngestion({
      sources: fakeSourceDb(["good-a", "unreachable", "good-b"]),
      write: db,
      resolve: async (source) => {
        if (source === "unreachable") throw new Error("fetch failed: getaddrinfo ENOTFOUND")
        return manifest(source)
      },
      log: () => {},
    })

    // The failing source produced NO write call — its prior rows are left untouched.
    expect(calls.map((c) => c.source)).toEqual(["good-a", "good-b"])
    expect(result.resolutions).toEqual([
      { source: "good-a", ok: true, manifest: manifest("good-a") },
      { source: "unreachable", ok: false, error: "fetch failed: getaddrinfo ENOTFOUND" },
      { source: "good-b", ok: true, manifest: manifest("good-b") },
    ])
  })

  test("a write failure is isolated the same way a resolve failure is", async () => {
    const db: RegistryWriteDb = {
      async replaceMarketplace(input) {
        if (input.source === "db-down") throw new Error("D1_ERROR: storage caused object to be reset")
      },
    }

    const result = await runIngestion({
      sources: fakeSourceDb(["db-down", "fine"]),
      write: db,
      resolve: async (source) => manifest(source),
      log: () => {},
    })

    expect(result.resolutions).toEqual([
      { source: "db-down", ok: false, error: "D1_ERROR: storage caused object to be reset" },
      { source: "fine", ok: true, manifest: manifest("fine") },
    ])
  })

  test("a non-Error throw is still stringified into a readable failure", async () => {
    const { db } = fakeWriteDb()

    const result = await runIngestion({
      sources: fakeSourceDb(["weird"]),
      write: db,
      resolve: async () => {
        throw "not an Error instance"
      },
      log: () => {},
    })

    expect(result.resolutions).toEqual([{ source: "weird", ok: false, error: "not an Error instance" }])
  })

  test("zero registered sources: no-op, not an error", async () => {
    const { calls, db } = fakeWriteDb()

    const result = await runIngestion({
      sources: fakeSourceDb([]),
      write: db,
      resolve: async (source) => manifest(source),
      log: () => {},
    })

    expect(calls).toEqual([])
    expect(result.resolutions).toEqual([])
  })

  test("logs once per source, success or failure, in resolution order", async () => {
    const { db } = fakeWriteDb()
    const logged: SourceResolution[] = []

    await runIngestion({
      sources: fakeSourceDb(["ok-source", "bad-source"]),
      write: db,
      resolve: async (source) => {
        if (source === "bad-source") throw new Error("boom")
        return manifest(source)
      },
      log: (result) => logged.push(result),
    })

    expect(logged.map((r) => [r.source, r.ok])).toEqual([
      ["ok-source", true],
      ["bad-source", false],
    ])
  })

  test("omitting `log` falls back to console output rather than throwing", async () => {
    const { db } = fakeWriteDb()

    // No `log` in deps: exercises `defaultLog`, which is not itself exported. This only
    // proves the default path runs without throwing — asserting exact console output would
    // pin an implementation detail (console.log vs console.error wording) this codebase
    // elsewhere avoids pinning.
    await expect(
      runIngestion({ sources: fakeSourceDb(["a-source"]), write: db, resolve: async (source) => manifest(source) }),
    ).resolves.toBeDefined()
  })
})
