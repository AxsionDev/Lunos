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
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ memory: { backend: { type: "mongodb" } } })).toThrow()
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
    expect(checked.warnings[0]).toContain("not fully verified")
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
    expect(MemoryExternal.region("NO")).toBe("eu")
    expect(MemoryExternal.region("IS")).toBe("eu")
    expect(MemoryExternal.region("LI")).toBe("eu")
    expect(MemoryExternal.region("CH")).toBe("other")
    expect(MemoryExternal.region("GB")).toBe("other")
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

// The live tests against real databases are in external-contract.test.ts (one suite per vendor).
