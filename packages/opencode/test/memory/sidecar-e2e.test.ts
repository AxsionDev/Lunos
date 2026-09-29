import { describe, expect, test } from "bun:test"
import path from "node:path"
import { MemoryBackend } from "../../src/memory/backend"
import { MemorySidecar } from "../../src/memory/sidecar"
import { MemoryStore } from "../../src/memory/store"
import { tmpdir } from "../fixture/fixture"

// Runs the real Cognee sidecar with uv. The first run installs ~180 locked packages and an 87 MB
// embedding model, so it is opt-in: LUNOS_MEMORY_E2E=1 bun test test/memory/sidecar-e2e.test.ts
// Add LUNOS_MEMORY_E2E_CACHE=<dir> to keep the downloads between runs.
const run = process.env.LUNOS_MEMORY_E2E === "1" && Bun.which("uv") ? test : test.skip

/** Stands in for the memory model: answers Cognee's sampling requests from the fact text. */
const sample: MemorySidecar.Sample = async (input) => {
  const schema = JSON.parse(input.system?.match(/JSON Schema:\n(\{.*\})/s)?.[1] ?? "{}")
  if (schema.title === "KnowledgeGraph") {
    const nodes: object[] = []
    const edges: object[] = []
    for (const [, owner, table] of input.text.matchAll(/the (\w+) service owns the (\w+) table/gi)) {
      nodes.push(
        { id: `${owner} service`, name: `${owner} service`, type: "Service", description: `The ${owner} service` },
        { id: `${table} table`, name: `${table} table`, type: "Table", description: `The ${table} table` },
      )
      edges.push({ source_node_id: `${owner} service`, target_node_id: `${table} table`, relationship_name: "owns" })
    }
    return JSON.stringify({ nodes, edges })
  }
  if (schema.title === "SummarizedContent") return JSON.stringify({ summary: input.text.slice(0, 80), description: "" })
  return "{}"
}

describe("memory sidecar, end to end", () => {
  run(
    "remember, recall with provenance, forget, and the forgotten fact is gone from the graph",
    async () => {
      await using tmp = await tmpdir()
      const root = await MemoryStore.ensure("project", tmp.path)
      // The test preload points XDG dirs at a fresh temp dir, so uv's cache and the embedding model
      // would be downloaded on every run. LUNOS_MEMORY_E2E_CACHE keeps them between runs, which
      // is what lets this test run with the network switched off.
      const cache = process.env.LUNOS_MEMORY_E2E_CACHE
      const handle = await MemorySidecar.start({
        root,
        sample,
        env: cache ? { ...process.env, UV_CACHE_DIR: path.join(cache, "uv") } : undefined,
        models: cache ? path.join(cache, "models") : undefined,
      })
      const backend = MemoryBackend.cognee({ root, handle, limits: MemoryBackend.DEFAULT_LIMITS })
      try {
        const provenance = { sessionID: "ses_1", agent: "build", source: "user message", date: "2026-09-26" }
        const billing = await backend.remember("The billing service owns the invoices table.", provenance)
        await backend.remember("The shipping service owns the parcels table.", provenance)

        const before = await backend.recall("who owns the invoices table?", 5)
        expect(before.facts[0].fact.text).toContain("billing service")
        expect(before.facts[0].fact.provenance).toEqual(provenance)
        expect(before.graph).toContain("billing service")

        expect(await backend.forget(billing.id)).toBe(true)
        const after = await backend.recall("who owns the invoices table?", 5)
        expect(after.facts.map((item) => item.fact.text).join()).not.toContain("billing")
        expect(after.graph).not.toContain("billing service")
        expect((await backend.list()).map((fact) => fact.text)).toEqual([
          "The shipping service owns the parcels table.",
        ])
        expect(await Bun.file(path.join(root, ".gitignore")).text()).toBe("*\n")
      } finally {
        await backend.close()
      }
    },
    15 * 60_000,
  )
})
