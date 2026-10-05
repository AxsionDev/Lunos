import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { MemoryBundle } from "../../src/memory/bundle"
import { tmpdir } from "../fixture/fixture"

// The shape of Cognee's graph after remembering three facts, as the sidecar's `graph` tool returned
// it in a real run (ids shortened): each fact is a TextDocument, its chunk `contains` the entities
// extracted from it, and each entity `is_a` an EntityType.
const raw: MemoryBundle.RawGraph = {
  nodes: [
    { id: "sum1", type: "TextSummary", name: "", description: "" },
    { id: "chunk1", type: "DocumentChunk", name: "", description: "" },
    { id: "fact-a", type: "TextDocument", name: "text_b72e", description: "" },
    { id: "billing", type: "Entity", name: "billing service", description: "The billing service" },
    { id: "t-service", type: "EntityType", name: "service", description: "service" },
    { id: "invoices", type: "Entity", name: "invoices table", description: "The invoices table" },
    { id: "t-table", type: "EntityType", name: "table", description: "table" },
    { id: "chunk2", type: "DocumentChunk", name: "", description: "" },
    { id: "fact-b", type: "TextDocument", name: "text_050d", description: "" },
    { id: "shipping", type: "Entity", name: "shipping service", description: "The shipping service" },
    { id: "parcels", type: "Entity", name: "parcels table", description: "The parcels table" },
    { id: "chunk3", type: "DocumentChunk", name: "", description: "" },
    { id: "fact-c", type: "TextDocument", name: "text_0481", description: "" },
    { id: "refunds", type: "Entity", name: "refunds table", description: "The refunds table" },
  ],
  edges: [
    { source: "sum1", target: "chunk1", relationship: "made_from" },
    { source: "chunk1", target: "fact-a", relationship: "is_part_of" },
    { source: "chunk1", target: "billing", relationship: "contains" },
    { source: "chunk1", target: "invoices", relationship: "contains" },
    { source: "billing", target: "t-service", relationship: "is_a" },
    { source: "billing", target: "invoices", relationship: "owns" },
    { source: "billing", target: "refunds", relationship: "owns" },
    { source: "invoices", target: "t-table", relationship: "is_a" },
    { source: "chunk2", target: "fact-b", relationship: "is_part_of" },
    { source: "chunk2", target: "shipping", relationship: "contains" },
    { source: "chunk2", target: "parcels", relationship: "contains" },
    { source: "shipping", target: "t-service", relationship: "is_a" },
    { source: "shipping", target: "parcels", relationship: "owns" },
    { source: "parcels", target: "t-table", relationship: "is_a" },
    // An extracted relationship that happens to be called "contains", between two entities.
    { source: "shipping", target: "parcels", relationship: "contains" },
    { source: "chunk3", target: "fact-c", relationship: "is_part_of" },
    { source: "chunk3", target: "billing", relationship: "contains" },
    { source: "chunk3", target: "refunds", relationship: "contains" },
    { source: "refunds", target: "t-table", relationship: "is_a" },
  ],
}

describe("MemoryBundle.graph", () => {
  test("entities and relationships point at the facts they came from", () => {
    const graph = MemoryBundle.graph("project", raw, new Set(["fact-a", "fact-b", "fact-c"]))
    expect(graph.entities).toEqual([
      {
        id: "project:billing",
        scope: "project",
        name: "billing service",
        type: "service",
        description: "The billing service",
        facts: ["fact-a", "fact-c"],
      },
      {
        id: "project:invoices",
        scope: "project",
        name: "invoices table",
        type: "table",
        description: "The invoices table",
        facts: ["fact-a"],
      },
      {
        id: "project:shipping",
        scope: "project",
        name: "shipping service",
        type: "service",
        description: "The shipping service",
        facts: ["fact-b"],
      },
      {
        id: "project:parcels",
        scope: "project",
        name: "parcels table",
        type: "table",
        description: "The parcels table",
        facts: ["fact-b"],
      },
      {
        id: "project:refunds",
        scope: "project",
        name: "refunds table",
        type: "table",
        description: "The refunds table",
        facts: ["fact-c"],
      },
    ])
    expect(graph.relations).toEqual([
      {
        scope: "project",
        source: "project:billing",
        target: "project:invoices",
        relationship: "owns",
        facts: ["fact-a"],
      },
      {
        scope: "project",
        source: "project:billing",
        target: "project:refunds",
        relationship: "owns",
        facts: ["fact-c"],
      },
      {
        scope: "project",
        source: "project:shipping",
        target: "project:parcels",
        relationship: "owns",
        facts: ["fact-b"],
      },
      {
        scope: "project",
        source: "project:shipping",
        target: "project:parcels",
        relationship: "contains",
        facts: ["fact-b"],
      },
    ])
  })

  test("only facts in the export are referenced: the rest, and what hangs only off them, is dropped", () => {
    const known = new Set(["fact-a", "fact-b"])
    const graph = MemoryBundle.graph("user", raw, known)
    expect(graph.entities.map((entity) => entity.id)).toEqual([
      "user:billing",
      "user:invoices",
      "user:shipping",
      "user:parcels",
    ])
    expect(graph.entities.find((entity) => entity.id === "user:billing")!.facts).toEqual(["fact-a"])
    expect(graph.relations.some((relation) => relation.target === "user:refunds")).toBe(false)
    for (const item of [...graph.entities, ...graph.relations])
      for (const id of item.facts) expect(known.has(id)).toBe(true)
  })
})

describe("MemoryBundle encryption", () => {
  test("round-trips with the passphrase, and refuses any other", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    const sealed = MemoryBundle.encrypt(zip, "passphrase one")
    expect([...MemoryBundle.decrypt(sealed, "passphrase one")]).toEqual([...zip])
    for (let i = 0; i < 20; i++) expect(() => MemoryBundle.decrypt(sealed, `wrong ${i}`)).toThrow("wrong passphrase")
  })
})

describe("MemoryBundle performance", () => {
  test("5,000 facts with a proportional graph: directory, zip and encrypted zip each well under 30 s", async () => {
    await using tmp = await tmpdir()
    const facts = Array.from({ length: 5000 }, (_, i) =>
      MemoryBundle.fact(i % 2 ? "user" : "project", {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        datasetID: "d",
        text: `The service number ${i} owns the table number ${i}, and its on-call rota is kept in the ops handbook, section ${i % 40}.`,
        provenance: {
          sessionID: `ses_${i % 97}`,
          agent: "build",
          source: "user message",
          date: "2026-09-26T10:00:00.000Z",
        },
      }),
    )
    // Two entities and one relationship per fact, and the graph nodes Cognee adds around them.
    const nodes: MemoryBundle.RawNode[] = []
    const edges: MemoryBundle.RawEdge[] = []
    for (const fact of facts.filter((item) => item.scope === "project")) {
      const n = fact.id.slice(-6)
      nodes.push(
        { id: fact.id, type: "TextDocument", name: "", description: "" },
        { id: `c${n}`, type: "DocumentChunk", name: "", description: "" },
        { id: `s${n}`, type: "Entity", name: `service ${n}`, description: `The service ${n}` },
        { id: `t${n}`, type: "Entity", name: `table ${n}`, description: `The table ${n}` },
      )
      edges.push(
        { source: `c${n}`, target: fact.id, relationship: "is_part_of" },
        { source: `c${n}`, target: `s${n}`, relationship: "contains" },
        { source: `c${n}`, target: `t${n}`, relationship: "contains" },
        { source: `s${n}`, target: `t${n}`, relationship: "owns" },
      )
    }
    const timings: Record<string, number> = {}
    for (const mode of ["dir", "zip", "encrypted"] as const) {
      const start = performance.now()
      const graph = MemoryBundle.graph("project", { nodes, edges }, new Set(facts.map((fact) => fact.id)))
      const secrets = MemoryBundle.secrets({ facts, graph, notes: [] })
      const bundle = await MemoryBundle.entries({
        version: "test",
        created: new Date(),
        scopes: ["project", "user"],
        facts,
        graph,
        notes: [],
      })
      await MemoryBundle.write({
        entries: bundle.entries,
        out: path.join(tmp.path, mode),
        zip: mode !== "dir",
        passphrase: mode === "encrypted" ? "passphrase" : undefined,
      })
      timings[mode] = performance.now() - start
      expect(secrets).toEqual([])
      expect(bundle.manifest.counts).toMatchObject({ facts: { total: 5000 }, entities: 5000, relations: 2500 })
    }
    console.log("5,000-fact export timings (ms):", JSON.stringify(timings))
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(30_000)
    expect((await fs.stat(path.join(tmp.path, "zip"))).size).toBeGreaterThan(0)
  }, 120_000)
})
