import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { MemoryStore } from "../../src/memory/store"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))

const fact = {
  id: "f1",
  datasetID: "d",
  text: "The billing service owns the invoices table.",
  provenance: { sessionID: "ses_1", agent: "build", source: "user message", date: "2026-09-26T10:00:00Z" },
}

const seed = Effect.gen(function* () {
  const directory = (yield* TestInstance).directory
  yield* Effect.promise(async () => {
    const root = await MemoryStore.ensure("project", directory)
    await MemoryStore.add(root, fact)
  })
  return directory
})

// XCOD-94: the routes behind the TUI memory browser.
describe("memory routes", () => {
  it.instance(
    "list reads the ledger with provenance, even with memory off, and starts nothing",
    Effect.gen(function* () {
      const directory = yield* seed
      const response = yield* requestInDirectory("/memory", directory)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        on: false,
        reason: 'memory is off; set "memory": { "enabled": true } to turn it on',
        facts: [
          {
            id: "f1",
            scope: "project",
            text: fact.text,
            sessionID: "ses_1",
            agent: "build",
            source: "user message",
            date: "2026-09-26T10:00:00Z",
          },
        ],
      })
      const sidecar = yield* Effect.promise(() =>
        fs.stat(MemoryStore.sidecarDir()).then(
          () => true,
          () => false,
        ),
      )
      expect(sidecar).toBe(false)
    }),
  )

  it.instance(
    "forget refuses while memory is off, and an unknown id is a 404",
    Effect.gen(function* () {
      const directory = yield* seed
      const off = yield* requestInDirectory("/memory/f1/forget", directory, { method: "POST" })
      expect(off.status).toBe(409)
      expect(((yield* off.json) as { message: string }).message).toContain("Memory is off")
      const missing = yield* requestInDirectory("/memory/nope/forget", directory, { method: "POST" })
      expect(missing.status).toBe(404)
      const related = yield* requestInDirectory("/memory/nope/related", directory)
      expect(related.status).toBe(404)
    }),
  )

  // XCOD-132: the TUI's Export action.
  it.instance(
    "export writes a bundle with the CLI's options, and with memory off asks for --no-graph instead of starting it",
    Effect.gen(function* () {
      const directory = yield* seed
      const post = (body: object) =>
        requestInDirectory("/memory/export", directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const off = yield* post({ out: "with-graph" })
      expect(off.status).toBe(409)
      expect(((yield* off.json) as { message: string }).message).toContain("--no-graph")

      const ok = yield* post({ graph: false, zip: true, passphrase: "a long passphrase", out: "memory.zip.enc" })
      expect(ok.status).toBe(200)
      const result = (yield* ok.json) as Record<string, unknown>
      expect(result).toMatchObject({
        path: path.join(directory, "memory.zip.enc"),
        format: "bundle",
        facts: 1,
        graph: false,
        encrypted: true,
      })
      expect(result.decrypt).toContain("openssl enc -d -aes-256-cbc")
      expect(JSON.stringify(result)).not.toContain("a long passphrase")
      const bytes = yield* Effect.promise(() => fs.readFile(path.join(directory, "memory.zip.enc")))
      expect(bytes.subarray(0, 8).toString()).toBe("Salted__")

      expect((yield* post({ graph: false, passphrase: "short" })).status).toBe(400)
      expect((yield* post({ graph: false, since: "not a date" })).status).toBe(400)
      expect((yield* post({ graph: false, since: "2026-09-01", includeIndex: true })).status).toBe(400)

      // With no out, the bundle goes to the data directory, never the worktree.
      const fallback = (yield* (yield* post({ graph: false })).json) as { path: string }
      expect(path.dirname(fallback.path)).toBe(MemoryStore.bundles())
      const sidecar = yield* Effect.promise(() =>
        fs.stat(MemoryStore.sidecarDir()).then(
          () => true,
          () => false,
        ),
      )
      expect(sidecar).toBe(false)
    }),
  )
})
