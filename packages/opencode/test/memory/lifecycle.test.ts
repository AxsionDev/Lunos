import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Audit } from "@opencode-ai/core/audit"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Schema } from "effect"
import { MemoryBackend } from "../../src/memory/backend"
import { MemoryBundle } from "../../src/memory/bundle"
import { MemoryImport } from "../../src/memory/import"
import { MemoryKey } from "../../src/memory/key"
import { MemoryLifecycle } from "../../src/memory/lifecycle"
import { MemoryRecall } from "../../src/memory/recall"
import type { MemorySidecar } from "../../src/memory/sidecar"
import { MemoryStore } from "../../src/memory/store"

// XCOD-136: outdated facts, expiry, ledger integrity and encryption at rest.

const provenance = (date = "2026-09-01T10:00:00.000Z"): MemoryStore.Provenance => ({
  sessionID: "ses_1",
  agent: "build",
  source: "user message",
  date,
})

const fact = (id: string, text: string, extra: Partial<MemoryStore.Fact> = {}): MemoryStore.Fact => ({
  id,
  datasetID: "ds",
  text,
  provenance: provenance(),
  ...extra,
})

const dirs: string[] = []
async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-lifecycle-"))
  dirs.push(dir)
  return dir
}

function fakeKeychain() {
  const items = new Map<string, string>()
  const keychain: MemoryKey.Keychain = {
    async get(input) {
      return items.get(`${input.service}/${input.name}`) ?? null
    },
    async set(input) {
      items.set(`${input.service}/${input.name}`, input.value)
    },
    async delete(input) {
      return items.delete(`${input.service}/${input.name}`)
    },
  }
  return { keychain, items }
}

/** A sidecar stand-in: remembers ids, recalls every stored fact, and a graph line naming them. */
function fakeHandle() {
  const stored = new Map<string, string>()
  let next = 0
  const handle = {
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      if (tool === "remember") {
        const id = `f${++next}`
        stored.set(id, String(args.text))
        return { id, dataset_id: "ds" } as T
      }
      if (tool === "recall")
        return {
          facts: [...stored.keys()].map((id, index) => ({ id, score: index })),
          graph: [...stored.values()].map((text) => `${text} --[says]--> it`).join("\n"),
        } as T
      if (tool === "forget") {
        stored.delete(String(args.id))
        return { status: "ok" } as T
      }
      return { nodes: [], edges: [] } as T
    },
    async close() {},
  }
  return { handle: handle as unknown as MemorySidecar.Handle, stored }
}

afterEach(async () => {
  MemoryKey.use(undefined)
  delete process.env[MemoryLifecycle.CLOCK_ENV]
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("config", () => {
  test("retention and encryption decode through the live ConfigV1.Info path", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({
      memory: { enabled: true, retention: { days: 1, grace_days: 0 }, encryption: "os-keychain" },
    })
    expect(decoded.memory?.retention).toEqual({ days: 1, grace_days: 0 })
    expect(decoded.memory?.encryption).toBe("os-keychain")
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ memory: { encryption: "aes" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ memory: { retention: { days: 0 } } })).toThrow()
  })

  test("the new audit events are known to the audit log", () => {
    for (const event of [
      "memory.remember",
      "memory.recall",
      "memory.forget",
      "memory.outdate",
      "memory.import",
      "memory.export",
      "memory.purge",
      "memory.verify_failed",
    ])
      expect(Audit.EVENTS as readonly string[]).toContain(event)
    expect(Audit.EVENTS as readonly string[]).not.toContain("memory.write")
  })
})

describe("contradictions", () => {
  test("the ticket's own example contradicts", () => {
    expect(MemoryLifecycle.contradicts("billing owns invoices", "ledger-service owns invoices")).toBe(true)
  })
  test("a changed value contradicts; an added detail doesn't", () => {
    expect(
      MemoryLifecycle.contradicts(
        "The billing service owns the invoices table.",
        "The billing service owns the payments table.",
      ),
    ).toBe(true)
    expect(MemoryLifecycle.contradicts("we deploy on Fridays", "we deploy on Fridays after review")).toBe(false)
    expect(MemoryLifecycle.contradicts("billing owns invoices", "billing owns invoices")).toBe(false)
    expect(MemoryLifecycle.contradicts("the build uses bun", "tests run in CI on Linux")).toBe(false)
  })
})

describe("expiry", () => {
  const policy = { days: 1, graceDays: 7 }
  test("retention.days: recalled for a day, expired after, purged after the grace period", () => {
    const item = fact("a", "x")
    expect(MemoryLifecycle.state(item, policy, new Date("2026-09-01T20:00:00Z"))).toBe("active")
    expect(MemoryLifecycle.state(item, policy, new Date("2026-09-02T10:00:01Z"))).toBe("expired")
    expect(MemoryLifecycle.state(item, policy, new Date("2026-09-09T10:00:01Z"))).toBe("purge")
  })
  test("notes never expire; a per-fact date wins over retention", () => {
    const note = fact("n", "x", { provenance: { ...provenance(), sessionID: "notes" } })
    expect(MemoryLifecycle.state(note, policy, new Date("2030-01-01"))).toBe("active")
    const own = fact("o", "x", { expires: "2026-12-01T00:00:00.000Z" })
    expect(MemoryLifecycle.state(own, policy, new Date("2026-11-01"))).toBe("active")
    expect(MemoryLifecycle.expiring([own], policy, 40, new Date("2026-11-01")).map((item) => item.fact.id)).toEqual([
      "o",
    ])
  })
  test("the clock can be moved for testing, and only for lifecycle checks", () => {
    process.env[MemoryLifecycle.CLOCK_ENV] = "2027-01-01T00:00:00Z"
    expect(MemoryLifecycle.now().toISOString()).toBe("2027-01-01T00:00:00.000Z")
  })
})

describe("ledger integrity", () => {
  test("a ledger is sealed: every line has a hash and a chain link", async () => {
    const root = await tmp()
    await MemoryStore.add(root, fact("a", "billing owns invoices"))
    await MemoryStore.add(root, fact("b", "shipping owns parcels"))
    const lines = (await fs.readFile(MemoryStore.ledgerFile(root), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines.every((line) => /^[0-9a-f]{64}$/.test(line.hash) && /^[0-9a-f]{64}$/.test(line.chain))).toBe(true)
    expect((await MemoryStore.load(root)).problems).toEqual([])
  })

  test("editing one byte of facts.jsonl quarantines exactly that fact", async () => {
    const root = await tmp()
    for (const [id, text] of [
      ["a", "billing owns invoices"],
      ["b", "shipping owns parcels"],
      ["c", "search owns the index"],
    ])
      await MemoryStore.add(root, fact(id, text))
    const file = MemoryStore.ledgerFile(root)
    const text = await fs.readFile(file, "utf8")
    await fs.writeFile(file, text.replace("shipping owns", "shipping owns".replace("o", "0")))
    const ledger = await MemoryStore.load(root)
    expect(ledger.problems.map((problem) => problem.id)).toEqual(["b"])
    expect(ledger.facts.filter((item) => item.quarantined).map((item) => item.id)).toEqual(["b"])
  })

  test("a damaged line, an edited chain field and a removed line each quarantine only what they touch", async () => {
    const root = await tmp()
    for (const id of ["a", "b", "c", "d"]) await MemoryStore.add(root, fact(id, `fact ${id} is stored`))
    const file = MemoryStore.ledgerFile(root)
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n")
    // b: not JSON any more. c: its chain value edited.
    lines[1] = lines[1].slice(0, -1)
    const c = JSON.parse(lines[2])
    lines[2] = JSON.stringify({ ...c, chain: c.chain.replace(/^./, c.chain[0] === "a" ? "b" : "a") })
    await fs.writeFile(file, lines.join("\n") + "\n")
    expect((await MemoryStore.load(root)).problems.map((problem) => problem.id)).toEqual(["b", "c"])

    const root2 = await tmp()
    for (const id of ["a", "b", "c"]) await MemoryStore.add(root2, fact(id, `fact ${id} is stored`))
    const file2 = MemoryStore.ledgerFile(root2)
    const kept = (await fs.readFile(file2, "utf8")).trim().split("\n")
    await fs.writeFile(file2, [kept[0], kept[2]].join("\n") + "\n")
    const problems = (await MemoryStore.load(root2)).problems
    expect(problems.map((problem) => problem.id)).toEqual(["c"])
    expect(problems[0].reason).toContain("hash chain")
  })

  test("a rewrite keeps an edited line quarantined; reseal accepts it; forget removes it", async () => {
    const root = await tmp()
    for (const id of ["a", "b", "c"]) await MemoryStore.add(root, fact(id, `fact ${id} is stored`))
    const file = MemoryStore.ledgerFile(root)
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("fact b is", "fact B is"))
    await MemoryStore.update(root, "c", (item) => ({ ...item, status: "outdated" }))
    expect((await MemoryStore.load(root)).problems.map((problem) => problem.id)).toEqual(["b"])
    await MemoryStore.rewrite(root, (items) => items, "off", { reseal: true })
    expect((await MemoryStore.load(root)).problems).toEqual([])
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("fact a is", "fact A is"))
    await MemoryStore.remove(root, "a")
    const after = await MemoryStore.load(root)
    expect(after.problems).toEqual([])
    expect(after.facts.map((item) => item.id)).toEqual(["b", "c"])
  })

  test("a ledger written before XCOD-136 is read as is, and sealed on the next write", async () => {
    const root = await tmp()
    await fs.writeFile(MemoryStore.ledgerFile(root), JSON.stringify(fact("a", "old fact here")) + "\n")
    const before = await MemoryStore.load(root)
    expect(before.unsealed).toBe(1)
    expect(before.problems).toEqual([])
    await MemoryStore.prepare(root, "off")
    const after = await MemoryStore.load(root)
    expect(after.unsealed).toBe(0)
    expect(after.problems).toEqual([])
  })
})

describe("encryption at rest", () => {
  test("with os-keychain the ledger holds no plain text, and reads back normally", async () => {
    MemoryKey.use(fakeKeychain().keychain)
    const root = await tmp()
    await MemoryStore.add(root, fact("a", "billing owns invoices"), "os-keychain")
    const raw = await fs.readFile(MemoryStore.ledgerFile(root), "utf8")
    expect(raw).not.toContain("billing")
    expect(raw).not.toContain("user message")
    expect((await MemoryStore.facts(root)).map((item) => item.text)).toEqual(["billing owns invoices"])
  })

  test("turning it on encrypts an existing ledger; one edited byte quarantines one fact", async () => {
    MemoryKey.use(fakeKeychain().keychain)
    const root = await tmp()
    await MemoryStore.add(root, fact("a", "billing owns invoices"))
    await MemoryStore.add(root, fact("b", "shipping owns parcels"))
    await MemoryStore.prepare(root, "os-keychain")
    const file = MemoryStore.ledgerFile(root)
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n")
    expect(lines.join("\n")).not.toContain("owns")
    const b = JSON.parse(lines[1])
    const flipped = b.enc[20] === "A" ? "B" : "A"
    lines[1] = JSON.stringify({ ...b, enc: b.enc.slice(0, 20) + flipped + b.enc.slice(21) })
    await fs.writeFile(file, lines.join("\n") + "\n")
    const ledger = await MemoryStore.load(root)
    expect(ledger.problems.map((problem) => problem.id)).toEqual(["b"])
    expect(ledger.facts.map((item) => item.id)).toEqual(["a"])
  })

  test("a missing keychain entry is a clear error, never an empty memory, and no new key is made", async () => {
    const { keychain, items } = fakeKeychain()
    MemoryKey.use(keychain)
    const root = await tmp()
    await MemoryStore.add(root, fact("a", "billing owns invoices"), "os-keychain")
    items.clear()
    MemoryKey.reset()
    await expect(MemoryStore.facts(root)).rejects.toThrow(/key is missing from the OS keychain/)
    await expect(MemoryStore.add(root, fact("b", "x y z"), "os-keychain")).rejects.toThrow(MemoryKey.KeyError)
    expect(items.size).toBe(0)
    expect((await fs.readFile(MemoryStore.ledgerFile(root), "utf8")).trim().split("\n")).toHaveLength(1)
  })
})

describe("the backend", () => {
  const limits = MemoryBackend.DEFAULT_LIMITS

  test("an outdated fact and its graph edges are not recalled; history shows it, marked", async () => {
    const root = await tmp()
    const { handle } = fakeHandle()
    const backend = MemoryBackend.cognee({ root, handle, limits })
    const old = await backend.remember("billing owns invoices", provenance())
    const next = await backend.remember("ledger-service owns invoices", provenance())
    const outdated = await backend.outdate(old.id, { by: next.id, at: new Date("2026-09-10T00:00:00Z") })
    expect(outdated).toMatchObject({ status: "outdated", replaced_by: next.id, invalid_at: "2026-09-10T00:00:00.000Z" })
    const now = await backend.recall("who owns invoices", 5)
    expect(now.facts.map((item) => item.fact.text)).toEqual(["ledger-service owns invoices"])
    const block = MemoryRecall.block([{ scope: "project", ...now }])!
    expect(block).not.toContain("billing")
    const history = await backend.recall("who owns invoices", 5, { history: true })
    const text = MemoryRecall.block([{ scope: "project", ...history }])!
    expect(text).toContain(`billing owns invoices [outdated since 2026-09-10, replaced by ${next.id}`)
    expect((await backend.list()).find((item) => item.id === next.id)?.replaces).toBe(old.id)
  })

  test("a quarantined fact is not recalled, and the graph that might hold it is left out", async () => {
    const root = await tmp()
    const { handle } = fakeHandle()
    const backend = MemoryBackend.cognee({ root, handle, limits })
    await backend.remember("billing owns invoices", provenance())
    await backend.remember("shipping owns parcels", provenance())
    const file = MemoryStore.ledgerFile(root)
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("billing owns", "billing 0wns"))
    const result = await backend.recall("owns", 5)
    expect(result.facts.map((item) => item.fact.text)).toEqual(["shipping owns parcels"])
    expect(result.graph).toBe("")
  })

  test("expiry: not recalled after a day, purged after the grace period", async () => {
    const root = await tmp()
    const { handle, stored } = fakeHandle()
    const backend = MemoryBackend.cognee({ root, handle, limits, retention: { days: 1, graceDays: 2 } })
    await backend.remember("the release is frozen", provenance(new Date().toISOString()))
    expect((await backend.recall("release", 5)).facts).toHaveLength(1)
    process.env[MemoryLifecycle.CLOCK_ENV] = new Date(Date.now() + 1.5 * 86_400_000).toISOString()
    expect((await backend.recall("release", 5)).facts).toHaveLength(0)
    const expired = await backend.sweep(MemoryLifecycle.now())
    expect(expired.expired).toHaveLength(1)
    expect(stored.size).toBe(0)
    expect(await backend.list()).toHaveLength(1)
    process.env[MemoryLifecycle.CLOCK_ENV] = new Date(Date.now() + 3.5 * 86_400_000).toISOString()
    const purged = await backend.sweep(MemoryLifecycle.now())
    expect(purged.purged).toHaveLength(1)
    expect(await backend.list()).toHaveLength(0)
  })

  test("recall labels inferred facts", () => {
    const block = MemoryRecall.block([
      {
        scope: "project",
        facts: [{ fact: fact("a", "the tests are slow", { kind: "inferred" }), score: 0 }],
        graph: "",
      },
    ])!
    expect(block).toContain("the tests are slow [inferred by the agent, project memory")
  })
})

describe("bundles", () => {
  test("lifecycle fields go into the bundle and validate against the published schema", async () => {
    const { default: Ajv } = await import("ajv/dist/2020")
    const ajv = new Ajv({ strict: false })
    ajv.addSchema(MemoryBundle.JSON_SCHEMA)
    const item = MemoryBundle.fact(
      "project",
      fact("a", "billing owns invoices", {
        status: "outdated",
        kind: "observed",
        invalid_at: "2026-09-10T00:00:00.000Z",
        replaced_by: "b",
        expires: "2027-01-01T00:00:00.000Z",
      }),
    )
    expect(item).toMatchObject({
      status: "outdated",
      kind: "observed",
      replaced_by: "b",
      expires: "2027-01-01T00:00:00.000Z",
    })
    expect(ajv.validate(`${MemoryBundle.JSON_SCHEMA.$id}#/$defs/fact`, item)).toBe(true)
    // A /1 fact written before XCOD-136, without the new fields, is still valid.
    const { valid_from: _v, invalid_at: _i, replaced_by: _r, expires: _e, ...plain } = item
    expect(
      ajv.validate(`${MemoryBundle.JSON_SCHEMA.$id}#/$defs/fact`, { ...plain, status: "active", kind: null }),
    ).toBe(true)
  })

  test("import keeps outdated status and kind, and rejects facts that have already expired", () => {
    const source: MemoryImport.Source = {
      kind: "bundle",
      label: "b",
      sha256: "0".repeat(64),
      notes: [],
      warnings: [],
      candidates: [
        {
          kind: "fact",
          scope: "project",
          text: "billing owns invoices",
          file: "facts.jsonl:1",
          from: "import:b#0",
          lifecycle: { status: "outdated", invalid_at: "2026-09-10T00:00:00Z", kind: "observed" },
        },
        {
          kind: "fact",
          scope: "project",
          text: "ledger-service owns invoices",
          file: "facts.jsonl:2",
          from: "import:b#0",
        },
        {
          kind: "fact",
          scope: "project",
          text: "the freeze ends Friday",
          file: "facts.jsonl:3",
          from: "import:b#0",
          lifecycle: { expires: "2020-01-01T00:00:00Z" },
        },
      ],
    }
    const planned = MemoryImport.plan(source, {
      existing: { facts: { project: [], user: [] }, notes: [] },
      limits: MemoryBackend.DEFAULT_LIMITS,
    })
    expect(planned.rows.map((row) => row.status)).toEqual(["new", "new", "rejected"])
    expect(planned.rows[0].reason).toContain("outdated")
    expect(planned.rows[2].reason).toContain("expired")
  })
})
