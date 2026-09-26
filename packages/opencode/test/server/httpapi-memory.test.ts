import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
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
})
