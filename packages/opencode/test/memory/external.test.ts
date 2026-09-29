import { afterAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Audit } from "@opencode-ai/core/audit"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Residency } from "@opencode-ai/core/residency"
import { Schema } from "effect"
import { AuditLog } from "../../src/audit/log"
import { ConfigMemoryBackend } from "../../src/config/memory-backend"
import { MemoryBackend } from "../../src/memory/backend"
import { MemoryExternal } from "../../src/memory/external"
import type { MemoryStore } from "../../src/memory/store"

// XCOD-134: memory in an external graph database.

const base = { type: "neo4j" as const, url: "bolt+s://graph.example.eu:7687", jurisdiction: "EU-DE" }
const eu = Residency.resolve({ allow: ["eu"] })

describe("config", () => {
  test("memory.backend decodes through the live ConfigV1.Info path", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({
      memory: {
        enabled: true,
        backend: {
          ...base,
          database: "lunos",
          username: "u",
          password: "p",
          read_only: true,
          allow_insecure: true,
          user: "x",
        },
      },
    })
    expect(decoded.memory?.backend).toEqual({
      ...base,
      database: "lunos",
      username: "u",
      password: "p",
      read_only: true,
      allow_insecure: true,
      user: "x",
    })
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ memory: { backend: { type: "postgres" } } })).toThrow()
  })

  test("credentials must be {env:} or {file:} references; the message never holds the value", () => {
    const check = (backend: object) => ConfigMemoryBackend.credentialProblems({ memory: { backend } })
    expect(check({ username: "{env:LUNOS_MEMORY_DB_USER}", password: "{file:~/.neo4j-pass}" })).toEqual([])
    const literal = check({ password: "s3cret-literal" })
    expect(literal).toHaveLength(1)
    expect(literal[0]).toContain("memory.backend.password")
    expect(literal[0]).not.toContain("s3cret-literal")
    expect(check({ username: "neo4j" })[0]).toContain("memory.backend.username")
    // A reference with a literal around it is still a literal.
    expect(check({ password: "x{env:PASS}" })).toHaveLength(1)
    expect(check({ url: "bolt://neo4j:pw@localhost:7687" })[0]).toContain("must not contain credentials")
    expect(ConfigMemoryBackend.credentialProblems({ memory: { enabled: true } })).toEqual([])
  })
})

describe("gate: checked before any connection", () => {
  const gate = (backend: object, extra: object = {}, residency: Residency.Resolved | undefined = eu) =>
    MemoryExternal.gate({ memory: { backend: { ...base, ...backend }, ...extra } as never, residency })

  test("an EU jurisdiction under an EU policy passes, over verified TLS", () => {
    const checked = gate({})
    expect(checked.host).toBe("graph.example.eu")
    expect(checked.tls).toBe("verified")
    expect(checked.warnings).toEqual([])
  })

  test("a jurisdiction is required", () => {
    expect(() => gate({ jurisdiction: undefined })).toThrow(/jurisdiction is required/)
    expect(() => gate({ jurisdiction: "somewhere nice" })).toThrow(/should look like/)
  })

  test("a US jurisdiction under an EU-only policy is refused and recorded as memory.denied naming memory.backend", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-external-"))
    const file = path.join(dir, "audit.log")
    AuditLog.activate({ enabled: true, file, redact: [] })
    try {
      expect(() => gate({ jurisdiction: "US" })).toThrow(MemoryExternal.DeniedError)
      await AuditLog.flush()
      const lines = (await fs.readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        event: "memory.denied",
        setting: "memory.backend",
        host: "graph.example.eu",
        jurisdiction: "US",
        region: "us",
      })
    } finally {
      AuditLog.activate({ enabled: false, file, redact: [] })
      await fs.rm(dir, { recursive: true, force: true })
    }
    expect(Audit.EVENTS as readonly string[]).toContain("memory.denied")
  })

  test("without a residency policy any declared jurisdiction passes", () => {
    expect(
      MemoryExternal.gate({ memory: { backend: { ...base, jurisdiction: "US" } }, residency: undefined }).settings
        .jurisdiction,
    ).toBe("US")
  })

  test("plain bolt:// to a remote host is refused unless allow_insecure, which warns", () => {
    expect(() => gate({ url: "bolt://graph.example.eu:7687" })).toThrow(/unencrypted/)
    expect(() => gate({ url: "neo4j://10.0.0.5:7687" })).toThrow(/unencrypted/)
    const allowed = gate({ url: "bolt://graph.example.eu:7687", allow_insecure: true })
    expect(allowed.tls).toBe("none")
    expect(allowed.warnings[0]).toContain("unencrypted")
  })

  test("plain bolt:// to this machine is allowed", () => {
    for (const url of ["bolt://localhost:7687", "bolt://127.0.0.1:7687", "neo4j://[::1]:7687"])
      expect(gate({ url }).tls).toBe("none")
  })

  test("+ssc is encrypted but unverified, and says so", () => {
    const checked = gate({ url: "bolt+ssc://graph.example.eu:7687" })
    expect(checked.tls).toBe("unverified")
    expect(checked.warnings[0]).toContain("not verified")
  })

  test("other schemes, credentials in the URL, memgraph and keychain encryption are refused", () => {
    expect(() => gate({ url: "http://graph.example.eu:7474" })).toThrow(/bolt\+s/)
    expect(() => gate({ url: "bolt+s://neo4j:pw@graph.example.eu:7687" })).toThrow(/credentials/)
    expect(() => gate({ type: "memgraph" })).toThrow(/not supported yet/)
    expect(() => gate({}, { encryption: "os-keychain" })).toThrow(/os-keychain/)
    expect(() => gate({ url: undefined })).toThrow(/url is required/)
  })

  test("jurisdictions map to residency regions", () => {
    expect(MemoryExternal.region("EU-DE")).toBe("eu")
    expect(MemoryExternal.region("eu")).toBe("eu")
    expect(MemoryExternal.region("DE")).toBe("eu")
    expect(MemoryExternal.region("US-EAST")).toBe("us")
    expect(MemoryExternal.region("CH")).toBe("other")
  })
})

describe("identities", () => {
  test("the same remote in scp, ssh and https form is one project", () => {
    const forms = [
      "git@github.com:AxsionDev/Lunos.git",
      "ssh://git@github.com/AxsionDev/Lunos.git",
      "https://github.com/AxsionDev/Lunos",
      "https://token:x-oauth@GitHub.com/AxsionDev/Lunos.git/",
    ]
    expect(new Set(forms.map(MemoryExternal.normalizeRemote))).toEqual(new Set(["github.com/AxsionDev/Lunos"]))
    expect(MemoryExternal.normalizeRemote("https://github.com/AxsionDev/Other")).not.toBe(
      MemoryExternal.normalizeRemote(forms[0]),
    )
  })

  test("a configured user is hashed, never stored as written", async () => {
    const a = await MemoryExternal.userID("alice@example.com")
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(await MemoryExternal.userID("alice@example.com"))
    expect(a).not.toBe(await MemoryExternal.userID("bob@example.com"))
  })

  test("full-text queries drop Lucene syntax", () => {
    expect(MemoryExternal.textQuery('Who owns "the" invoices: table? (AND) -x*')).toBe(
      "who OR owns OR the OR invoices OR table",
    )
    expect(MemoryExternal.textQuery("?!")).toBe("")
  })
})

// Against a real database. Run with, for example:
//   docker run -d -p 127.0.0.1:47687:7687 -e NEO4J_AUTH=neo4j/<password> neo4j:5
//   LUNOS_TEST_NEO4J_URL=bolt://127.0.0.1:47687 LUNOS_TEST_NEO4J_PASSWORD=<password> bun test test/memory/external.test.ts
const url = process.env.LUNOS_TEST_NEO4J_URL
describe.skipIf(!url)("neo4j (live)", () => {
  const run = crypto.randomUUID().slice(0, 8)
  const opened: MemoryExternal.External[] = []
  const open = async (namespace: string, extra: object = {}) => {
    const checked = MemoryExternal.gate({
      memory: {
        backend: {
          type: "neo4j",
          url,
          jurisdiction: "EU-DE",
          username: "neo4j",
          password: process.env.LUNOS_TEST_NEO4J_PASSWORD,
          ...extra,
        },
      } as never,
      residency: eu,
    })
    const store = await MemoryExternal.neo4j({
      checked,
      scope: "project",
      worktree: "/nonexistent",
      limits: MemoryBackend.DEFAULT_LIMITS,
      namespace: `test:${run}:${namespace}`,
    })
    opened.push(store)
    return store
  }
  const provenance: MemoryStore.Provenance = {
    sessionID: "ses_1",
    agent: "build",
    source: "user message",
    date: "2026-09-01T10:00:00.000Z",
  }
  afterAll(async () => {
    for (const store of opened) {
      if (!store.readOnly) await store.purge().catch(() => {})
      await store.close()
    }
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
    expect(await store.forget(billing.id)).toBe(true)
    expect((await store.list()).map((fact) => fact.text)).toEqual(["The search team owns the index repo."])
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

  test("an edited node is quarantined and never recalled", async () => {
    const store = await open("tamper")
    const fact = await store.remember("The data team owns the events queue.", provenance)
    const lib = (await import("neo4j-driver")).default
    const driver = lib.driver(url!, lib.auth.basic("neo4j", process.env.LUNOS_TEST_NEO4J_PASSWORD ?? ""))
    await driver.executeQuery(
      "MATCH (f:LunosMemoryFact {id: $id}) SET f.record = replace(f.record, 'data team', 'evil team')",
      { id: fact.id },
    )
    await driver.close()
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
})
