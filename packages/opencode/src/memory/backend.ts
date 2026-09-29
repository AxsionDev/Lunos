export * as MemoryBackend from "./backend"

import { MemorySidecar } from "./sidecar"
import { MemoryStore } from "./store"

/**
 * The engine behind memory (XCOD-94). Tools, commands and the TUI use only this interface, so the
 * engine can be replaced (the in-process cognee-ts once it matures, or Graphiti for organisations
 * running Neo4j) without touching them.
 */
export interface Recalled {
  fact: MemoryStore.Fact
  /** Distance from the query: lower is closer. */
  score: number
}

export interface Backend {
  remember(text: string, provenance: MemoryStore.Provenance): Promise<MemoryStore.Fact>
  recall(query: string, limit: number): Promise<{ facts: Recalled[]; graph: string }>
  forget(id: string): Promise<boolean>
  list(): Promise<MemoryStore.Fact[]>
  close(): Promise<void>
}

export class LimitError extends Error {
  override name = "MemoryLimit"
}

export interface Limits {
  maxFacts: number
  maxFactChars: number
}

export const DEFAULT_LIMITS: Limits = { maxFacts: 5000, maxFactChars: 2000 }

/**
 * Cognee through the sidecar. The ledger is written only after the engine has stored the fact, and
 * removed only after the engine has forgotten it, so the ledger never lists a fact the graph
 * doesn't hold. Recall drops any engine result the ledger doesn't know: a fact without provenance
 * is never shown to the model.
 */
export function cognee(input: { root: string; handle: MemorySidecar.Handle; limits: Limits }): Backend {
  const { root, handle, limits } = input
  return {
    async remember(text, provenance) {
      const trimmed = text.trim()
      if (!trimmed) throw new LimitError("Nothing to remember")
      if (trimmed.length > limits.maxFactChars)
        throw new LimitError(
          `A fact can be at most ${limits.maxFactChars} characters (memory.limits.max_fact_chars); this one is ${trimmed.length}`,
        )
      const existing = await MemoryStore.facts(root)
      const same = existing.find((fact) => fact.text === trimmed)
      if (same) return same
      const count = existing.length
      if (count >= limits.maxFacts)
        throw new LimitError(
          `Memory holds ${count} facts, the most allowed (memory.limits.max_facts). Forget some before remembering more`,
        )
      const stored = await handle.call<{ id: string; dataset_id: string }>("remember", {
        text: trimmed,
        dataset: MemoryStore.DATASET,
      })
      const fact = { id: stored.id, datasetID: stored.dataset_id, text: trimmed, provenance }
      await MemoryStore.add(root, fact)
      return fact
    },
    async recall(query, limit) {
      const known = new Map((await MemoryStore.facts(root)).map((fact) => [fact.id, fact]))
      if (known.size === 0) return { facts: [], graph: "" }
      const result = await handle.call<{ facts: { id: string; score: number }[]; graph: string }>("recall", {
        query,
        dataset: MemoryStore.DATASET,
        top_k: limit,
      })
      // Cognee's CHUNKS score is a vector distance: lower is closer. Its result order isn't
      // guaranteed, so sort here.
      const facts = result.facts
        .flatMap((item) => {
          const fact = known.get(item.id)
          return fact ? [{ fact, score: item.score }] : []
        })
        .toSorted((a, b) => a.score - b.score)
      return { facts, graph: result.graph }
    },
    async forget(id) {
      const fact = (await MemoryStore.facts(root)).find((item) => item.id === id)
      if (!fact) return false
      await handle.call("forget", { id: fact.id, dataset_id: fact.datasetID })
      await MemoryStore.remove(root, fact.id)
      return true
    },
    list() {
      return MemoryStore.facts(root)
    },
    close() {
      return handle.close()
    },
  }
}
