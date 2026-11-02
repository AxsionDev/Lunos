import { CloudOrg } from "@/cloud/org"

/**
 * XCOD-191: your organisation's team memory on its Lunos console, as a read-only memory source.
 * Only facts an owner or admin approved are served. The query goes to the console named by managed
 * `cloud.policy`, with the `lunos login` session's token; like every source it is checked against
 * the residency policy (its `jurisdiction`) before it is first contacted, and its results are
 * screened, capped, labelled and never stored locally (sources/index.ts).
 */
export interface Client {
  search(query: string, limit: number, timeoutMs: number): Promise<string[]>
  close(): Promise<void>
}

export function connect(org: CloudOrg.Org, opts: CloudOrg.Options = {}): Client {
  return {
    async search(query, limit, timeoutMs) {
      const params = new URLSearchParams({ q: query.slice(0, 2000), limit: String(limit) })
      const response = await CloudOrg.request(
        org,
        `/memory?${params}`,
        { method: "GET", what: `${org.org}'s team memory` },
        { timeoutMs, ...opts },
      )
      const body = (await response.json().catch(() => undefined)) as { facts?: Array<{ text?: unknown }> } | undefined
      return (body?.facts ?? []).map((fact) => fact.text).filter((text): text is string => typeof text === "string")
    },
    async close() {},
  }
}

export * as MemorySourceOrg from "./org"
