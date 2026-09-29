export * as MemoryBackend from "./backend"

import crypto from "node:crypto"
import type { MemoryBundle } from "./bundle"
import { MemoryLifecycle } from "./lifecycle"
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

/** What a stored fact may carry besides its text and provenance. */
export type Extra = Partial<
  Pick<
    MemoryStore.Fact,
    "origin" | "imported" | "kind" | "expires" | "valid_from" | "replaces" | "status" | "invalid_at" | "replaced_by"
  >
>

export interface Backend {
  /**
   * `extra` marks an imported fact (XCOD-133) and carries lifecycle fields (XCOD-136). A fact that
   * arrives already outdated (an import) goes into the ledger only: outdated facts are never in the
   * engine.
   */
  remember(text: string, provenance: MemoryStore.Provenance, extra?: Extra): Promise<MemoryStore.Fact>
  /**
   * Active facts closest to the query. With `history`, outdated facts whose words match are added
   * after them (they are not in the engine, so they are matched from the ledger).
   */
  recall(
    query: string,
    limit: number,
    options?: { history?: boolean },
  ): Promise<{ facts: Recalled[]; graph: string }>
  forget(id: string): Promise<boolean>
  /**
   * Mark a fact outdated (XCOD-136): kept in the ledger with `invalid_at` and, with `by`, a link to
   * the fact that replaces it; removed from the engine, so neither it nor its graph edges are
   * recalled. Undefined if no active fact has that id.
   */
  outdate(id: string, input: { by?: string; at: Date }): Promise<MemoryStore.Fact | undefined>
  /** Detach facts that have expired from the engine, and delete those past the grace period. */
  sweep(at: Date): Promise<{ expired: MemoryStore.Fact[]; purged: MemoryStore.Fact[] }>
  list(): Promise<MemoryStore.Fact[]>
  /** Every node and edge in the engine's graph, for export (XCOD-132). No model call. */
  graph(): Promise<MemoryBundle.RawGraph>
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

function overlap(query: string, text: string) {
  const want = new Set(MemoryLifecycle.words(query))
  if (!want.size) return 0
  const have = new Set(MemoryLifecycle.words(text))
  let shared = 0
  for (const word of want) if (have.has(word)) shared++
  return shared / want.size
}

/**
 * Cognee through the sidecar. The ledger is written only after the engine has stored the fact, and
 * removed only after the engine has forgotten it, so the ledger never lists a fact the graph
 * doesn't hold. Recall drops any engine result the ledger doesn't know, or knows as outdated,
 * expired or quarantined: such a fact is never shown to the model. When recall had to drop one,
 * the graph context for that scope is left out too, since its edges may come from that fact.
 */
export function cognee(input: {
  root: string
  handle: MemorySidecar.Handle
  limits: Limits
  mode?: MemoryStore.Mode
  retention?: MemoryLifecycle.Retention
}): Backend {
  const { root, handle, limits } = input
  const mode = input.mode ?? "off"
  const policy = input.retention ?? { graceDays: MemoryLifecycle.DEFAULT_GRACE_DAYS }
  const detach = async (fact: MemoryStore.Fact) => {
    if (fact.detached || !fact.datasetID) return
    await handle.call("forget", { id: fact.id, dataset_id: fact.datasetID })
  }
  return {
    async remember(text, provenance, extra) {
      const trimmed = text.trim()
      if (!trimmed) throw new LimitError("Nothing to remember")
      if (trimmed.length > limits.maxFactChars)
        throw new LimitError(
          `A fact can be at most ${limits.maxFactChars} characters (memory.limits.max_fact_chars); this one is ${trimmed.length}`,
        )
      const existing = await MemoryStore.facts(root)
      const same = existing.find((fact) => fact.text === trimmed && !fact.detached && !fact.quarantined)
      if (same) return same
      const count = existing.length
      if (count >= limits.maxFacts)
        throw new LimitError(
          `Memory holds ${count} facts, the most allowed (memory.limits.max_facts). Forget some before remembering more`,
        )
      const outdated = extra?.status === "outdated"
      const stored = outdated
        ? { id: crypto.randomUUID(), dataset_id: "" }
        : await handle.call<{ id: string; dataset_id: string }>("remember", {
            text: trimmed,
            dataset: MemoryStore.DATASET,
          })
      const fact: MemoryStore.Fact = { id: stored.id, datasetID: stored.dataset_id, text: trimmed, provenance }
      for (const key of [
        "origin",
        "imported",
        "kind",
        "expires",
        "valid_from",
        "replaces",
        "status",
        "invalid_at",
        "replaced_by",
      ] as const)
        if (extra?.[key] !== undefined) (fact as unknown as Record<string, unknown>)[key] = extra[key]
      if (outdated) fact.detached = true
      await MemoryStore.add(root, fact, mode)
      return fact
    },
    async recall(query, limit, options) {
      const all = await MemoryStore.facts(root)
      const known = new Map(all.map((fact) => [fact.id, fact]))
      const at = MemoryLifecycle.now()
      const excluded = all.filter((fact) => !MemoryLifecycle.recallable(fact, policy, at)).length
      const facts: Recalled[] = []
      let graph = ""
      if (all.some((fact) => !fact.detached)) {
        const result = await handle.call<{ facts: { id: string; score: number }[]; graph: string }>("recall", {
          query,
          dataset: MemoryStore.DATASET,
          top_k: limit + Math.min(excluded, 50),
        })
        let dropped = false
        for (const item of result.facts) {
          const fact = known.get(item.id)
          if (fact && MemoryLifecycle.recallable(fact, policy, at)) facts.push({ fact, score: item.score })
          else dropped = true
        }
        // Cognee's CHUNKS score is a vector distance: lower is closer. Its result order isn't
        // guaranteed, so sort here.
        facts.sort((a, b) => a.score - b.score)
        facts.splice(limit)
        graph = dropped ? "" : result.graph
      }
      if (options?.history) {
        const past = all
          .filter((fact) => !fact.quarantined && MemoryLifecycle.state(fact, policy, at) === "outdated")
          .map((fact) => ({ fact, score: 2 - overlap(query, fact.text) }))
          .filter((item) => item.score < 2)
          .toSorted((a, b) => a.score - b.score)
          .slice(0, limit)
        facts.push(...past)
      }
      return { facts, graph }
    },
    async forget(id) {
      const ledger = await MemoryStore.load(root)
      const fact = ledger.facts.find((item) => item.id === id)
      if (!fact) {
        // An unreadable line can still be forgotten by the id it claims.
        if (!ledger.problems.some((problem) => problem.id === id)) return false
        await MemoryStore.remove(root, id, mode)
        return true
      }
      await detach(fact)
      await MemoryStore.remove(root, fact.id, mode)
      return true
    },
    async outdate(id, change) {
      const all = await MemoryStore.facts(root)
      const fact = all.find((item) => item.id === id && !item.quarantined)
      if (!fact || !MemoryStore.isActive(fact)) return undefined
      await detach(fact)
      const at = change.at.toISOString()
      let updated: MemoryStore.Fact | undefined
      await MemoryStore.rewrite(
        root,
        (items) =>
          items.map((item) => {
            if (item.id === id) {
              updated = {
                ...item,
                status: "outdated",
                invalid_at: at,
                detached: true,
                ...(change.by ? { replaced_by: change.by } : {}),
              }
              return updated
            }
            if (change.by && item.id === change.by) return { ...item, replaces: id }
            return item
          }),
        mode,
      )
      return updated
    },
    async sweep(at) {
      const all = await MemoryStore.facts(root)
      const expired: MemoryStore.Fact[] = []
      const purged: MemoryStore.Fact[] = []
      for (const fact of all) {
        const state = MemoryLifecycle.state(fact, policy, at)
        if (state === "purge") purged.push(fact)
        else if (state === "expired" && !fact.detached) expired.push(fact)
      }
      if (!expired.length && !purged.length) return { expired, purged }
      for (const fact of [...expired, ...purged]) await detach(fact)
      const gone = new Set(purged.map((fact) => fact.id))
      const off = new Set(expired.map((fact) => fact.id))
      await MemoryStore.rewrite(
        root,
        (items) => items.filter((item) => !gone.has(item.id)).map((item) => (off.has(item.id) ? { ...item, detached: true } : item)),
        mode,
        { drop: gone },
      )
      return { expired, purged }
    },
    list() {
      return MemoryStore.facts(root)
    },
    graph() {
      return handle.call<MemoryBundle.RawGraph>("graph", { dataset: MemoryStore.DATASET })
    },
    close() {
      return handle.close()
    },
  }
}
