import { afterAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { Residency } from "@opencode-ai/core/residency"
import { MemoryBackend } from "../../src/memory/backend"
import { MemoryExternal } from "../../src/memory/external"
import type { MemoryStore } from "../../src/memory/store"

// XCOD-134 / XCOD-264: the external memory contract, run against each real database. A vendor is
// supported only when its suite passes. Run with, for example:
//   docker run -d -p 127.0.0.1:47687:7687 -e NEO4J_AUTH=neo4j/<password> neo4j:5
//   docker run -d -p 127.0.0.1:45432:5432 -e POSTGRES_USER=lunos -e POSTGRES_PASSWORD=<password> \
//     -e POSTGRES_DB=lunos_memory pgvector/pgvector:pg17
//   docker run -d -p 127.0.0.1:47688:7687 memgraph/memgraph   (expected to fail; see the end of this file)
//   LUNOS_TEST_NEO4J_URL=bolt://127.0.0.1:47687 LUNOS_TEST_NEO4J_PASSWORD=<password> \
//   LUNOS_TEST_POSTGRES_URL=postgres://127.0.0.1:45432/lunos_memory LUNOS_TEST_POSTGRES_PASSWORD=<password> \
//   LUNOS_TEST_MEMGRAPH_URL=bolt://127.0.0.1:47688 bun test test/memory/external-contract.test.ts

const eu = Residency.resolve({ allow: ["eu"] })

type Vendor = {
  type: MemoryExternal.Kind
  url?: string
  username?: string
  password?: string
  /** Edit a stored record behind Lunos's back. */
  tamper(id: string): Promise<void>
}

const vendors: Vendor[] = [
  {
    type: "neo4j",
    url: process.env.LUNOS_TEST_NEO4J_URL,
    username: "neo4j",
    password: process.env.LUNOS_TEST_NEO4J_PASSWORD,
    async tamper(id) {
      const lib = (await import("neo4j-driver")).default
      const driver = lib.driver(this.url!, lib.auth.basic("neo4j", this.password ?? ""))
      await driver.executeQuery(
        "MATCH (f:LunosMemoryFact {id: $id}) SET f.record = replace(f.record, 'data team', 'evil team')",
        { id },
      )
      await driver.close()
    },
  },
  {
    type: "postgres",
    url: process.env.LUNOS_TEST_POSTGRES_URL,
    username: process.env.LUNOS_TEST_POSTGRES_USER ?? "lunos",
    password: process.env.LUNOS_TEST_POSTGRES_PASSWORD,
    async tamper(id) {
      const sql = new Bun.SQL({ url: this.url!, username: this.username, password: this.password })
      await sql.unsafe(
        "UPDATE lunos_memory_fact SET record = replace(record, 'data team', 'evil team') WHERE id = $1",
        [id],
      )
      await sql.close()
    },
  },
]

const provenance: MemoryStore.Provenance = {
  sessionID: "ses_1",
  agent: "build",
  source: "user message",
  date: "2026-09-01T10:00:00.000Z",
}

for (const vendor of vendors) {
  describe.skipIf(!vendor.url)(`${vendor.type} (live contract)`, () => {
    const run = crypto.randomUUID().slice(0, 8)
    const opened: MemoryExternal.External[] = []
    const memory = (extra: object = {}) =>
      ({
        backend: {
          type: vendor.type,
          url: vendor.url,
          jurisdiction: "EU-DE",
          username: vendor.username,
          password: vendor.password,
          ...extra,
        },
      }) as never
    const open = async (namespace: string, extra: object = {}) => {
      const checked = MemoryExternal.gate({ memory: memory(extra), residency: eu })
      const store = await MemoryExternal.open({
        checked,
        scope: "project",
        worktree: "/nonexistent",
        limits: MemoryBackend.DEFAULT_LIMITS,
        namespace: `test:${run}:${namespace}`,
      })
      opened.push(store)
      return store
    }
    afterAll(async () => {
      for (const store of opened) {
        if (!store.readOnly) await store.purge().catch(() => {})
        await store.close()
      }
    })

    test("test connection: connects, writes, reads and deletes a probe", async () => {
      const result = await MemoryExternal.probe({ memory: memory(), residency: eu })
      expect(result).toMatchObject({ ok: true })
      const wrong = await MemoryExternal.probe({
        memory: memory({ url: vendor.url!.replace(/:\d+/, ":1") }),
        residency: eu,
      })
      expect(wrong).toMatchObject({ ok: false, error: { stage: "connect" } })
    })

    test("remember, recall with provenance, outdate, forget", async () => {
      const store = await open("a")
      const billing = await store.remember("The billing service owns the invoices table.", provenance, {
        kind: "observed",
      })
      await store.remember("The search team owns the index repo.", provenance)
      expect((await store.remember("The billing service owns the invoices table.", provenance)).id).toBe(billing.id)
      const found = await store.recall("who owns the invoices table?", 5)
      expect(found.facts[0].fact).toMatchObject({ id: billing.id, provenance, kind: "observed" })
      const outdated = await store.outdate(billing.id, { at: new Date() })
      expect(outdated?.status).toBe("outdated")
      expect((await store.recall("invoices table", 5)).facts.map((item) => item.fact.id)).not.toContain(billing.id)
      expect((await store.recall("invoices table", 5, { history: true })).facts.map((item) => item.fact.id)).toContain(
        billing.id,
      )
      // Remembering an outdated fact's text again stores a new, active fact that is recalled.
      const again = await store.remember("The billing service owns the invoices table.", provenance)
      expect(again.id).not.toBe(billing.id)
      expect(again.status ?? "active").toBe("active")
      expect((await store.recall("invoices table", 5)).facts.map((item) => item.fact.id)).toContain(again.id)
      expect(await store.forget(again.id)).toBe(true)
      expect(await store.forget(billing.id)).toBe(true)
      expect((await store.list()).map((fact) => fact.text)).toEqual(["The search team owns the index repo."])
    })

    test("two machines pointed at one database see the same facts", async () => {
      const first = await open("shared")
      const second = await open("shared")
      const fact = await first.remember("The payments team owns the ledger service.", provenance)
      expect((await second.recall("who owns the ledger service", 5)).facts.map((item) => item.fact)).toEqual([fact])
      expect(await second.forget(fact.id)).toBe(true)
      expect(await first.list()).toEqual([])
    })

    test("a migrated fact keeps its id; namespaces in one database never mix", async () => {
      const a = await open("proj-a")
      const b = await open("proj-b")
      const id = crypto.randomUUID()
      await a.remember("The platform team owns the deploy repo.", provenance, { id })
      expect((await a.list())[0].id).toBe(id)
      expect((await b.recall("platform team deploy repo", 5)).facts).toEqual([])
      expect(await b.list()).toEqual([])
      expect(await b.forget(id)).toBe(false)
      expect((await a.list()).length).toBe(1)
    })

    test("an edited record is quarantined and never recalled", async () => {
      const store = await open("tamper")
      const fact = await store.remember("The data team owns the events queue.", provenance)
      await vendor.tamper(fact.id)
      expect((await store.list())[0].quarantined).toContain("integrity hash")
      expect((await store.recall("events queue", 5)).facts).toEqual([])
      expect((await store.health()).problems).toHaveLength(1)
    })

    test("read_only: recall works, writes are refused", async () => {
      const writer = await open("ro")
      await writer.remember("The mobile team owns the app repo.", provenance)
      const reader = await open("ro", { read_only: true })
      expect((await reader.recall("mobile app repo", 5)).facts).toHaveLength(1)
      await expect(reader.remember("The x team owns the y repo.", provenance)).rejects.toThrow(/read_only/)
      await expect(reader.purge()).rejects.toThrow(/read_only/)
    })

    test("health reports the count, the last write and the server", async () => {
      const store = await open("health")
      await store.remember("The infra team owns the VPN.", provenance)
      const health = await store.health()
      expect(health).toMatchObject({ facts: 1, problems: [] })
      expect(health.lastWrite).toBeString()
      expect(health.server).toContain("127.0.0.1")
    })
  })
}

// Memgraph speaks Bolt, but fails this contract at the first step: it refuses schema changes inside
// the driver's managed transactions, and has no Neo4j-style full-text index (db.index.fulltext).
// So memory.backend.type "memgraph" stays refused, and the setup wizard shows it as "Coming soon".
// When this test starts failing, Memgraph may be ready: add it to `vendors` above.
const memgraph = process.env.LUNOS_TEST_MEMGRAPH_URL
describe.skipIf(!memgraph)("memgraph (live contract)", () => {
  test("fails the contract today, so it stays refused", async () => {
    const memory = { backend: { type: "neo4j", url: memgraph, jurisdiction: "EU-DE" } } as never
    const checked = MemoryExternal.gate({ memory, residency: eu })
    await expect(
      MemoryExternal.open({
        checked,
        scope: "project",
        worktree: "/nonexistent",
        limits: MemoryBackend.DEFAULT_LIMITS,
        namespace: `test:${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow(/not allowed in multicommand transactions|fulltext/i)
    expect(() =>
      MemoryExternal.gate({
        memory: { backend: { type: "memgraph", url: memgraph, jurisdiction: "EU-DE" } } as never,
        residency: eu,
      }),
    ).toThrow(/not supported yet/)
  })
})
