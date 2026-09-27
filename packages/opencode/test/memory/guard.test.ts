import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Permission } from "../../src/permission"
import type { MemoryBackend } from "../../src/memory/backend"
import { MemoryGuard } from "../../src/memory/guard"
import { MemoryNotes } from "../../src/memory/notes"
import { MemoryRecall } from "../../src/memory/recall"
import type { MemoryStore } from "../../src/memory/store"
import { tmpdir } from "../fixture/fixture"

const worktree = "/work/project"

function user(text = "hi"): SessionV1.WithParts {
  return {
    info: { id: "msg_u", role: "user", sessionID: "ses" },
    parts: [{ type: "text", text }],
  } as unknown as SessionV1.WithParts
}

function assistant(...tools: [string, Record<string, unknown>?][]): SessionV1.WithParts {
  return {
    info: { id: "msg_a", role: "assistant", sessionID: "ses" },
    parts: tools.map(([tool, input]) => ({ type: "tool", tool, state: { status: "completed", input: input ?? {} } })),
  } as unknown as SessionV1.WithParts
}

describe("MemoryGuard.taint", () => {
  test("a clean turn is fine, including reads inside the project", () => {
    expect(MemoryGuard.taint([user(), assistant(["read", { filePath: "/work/project/src/a.ts" }])], worktree)).toBe(
      undefined,
    )
    expect(MemoryGuard.taint([user(), assistant(["read", { filePath: "src/a.ts" }])], worktree)).toBe(undefined)
  })

  test("webfetch, websearch or an MCP resource earlier in the turn refuses", () => {
    for (const tool of ["webfetch", "websearch", "read_mcp_resource"])
      expect(MemoryGuard.taint([user(), assistant(["glob"]), assistant([tool])], worktree)).toContain(tool)
  })

  test("a read outside the project refuses", () => {
    expect(MemoryGuard.taint([user(), assistant(["read", { filePath: "/etc/hosts" }])], worktree)).toContain(
      "outside the project",
    )
    expect(MemoryGuard.taint([user(), assistant(["read", { filePath: "../other/x.md" }])], worktree)).toContain(
      "outside the project",
    )
  })

  test("only the current turn counts: a fetch before the last user message doesn't taint", () => {
    expect(MemoryGuard.taint([user(), assistant(["webfetch"]), user("new turn")], worktree)).toBe(undefined)
  })
})

describe("MemoryGuard.secret", () => {
  test("refuses substitutions and key-shaped strings", () => {
    expect(MemoryGuard.secret("the key is {env:OPENAI_API_KEY}")).toContain("substitution")
    expect(MemoryGuard.secret("read {file:~/.ssh/id_rsa}")).toContain("substitution")
    expect(MemoryGuard.secret("staging api_key=abc123def")).toContain("key")
    expect(MemoryGuard.secret("token sk-abcdefghijklmnopqrstuv")).toContain("key")
  })

  test("ordinary facts pass", () => {
    expect(MemoryGuard.secret("The billing service owns the invoices table.")).toBe(undefined)
  })
})

describe("the memory permission", () => {
  test('"memory": "deny" hides both memory tools; other rules leave them', () => {
    const tools = ["memory_remember", "memory_search", "read"]
    expect([...Permission.disabled(tools, [{ permission: "memory", pattern: "*", action: "deny" }])]).toEqual([
      "memory_remember",
      "memory_search",
    ])
    expect(Permission.disabled(tools, [{ permission: "*", pattern: "*", action: "allow" }]).size).toBe(0)
  })
})

function fact(id: string, text: string, source = "user message"): MemoryStore.Fact {
  return {
    id,
    datasetID: "d",
    text,
    provenance: { sessionID: "ses_1", agent: "build", source, date: "2026-09-26T10:00:00Z" },
  }
}

describe("MemoryRecall.block", () => {
  test("says it is reference context, and shows provenance for every fact, closest first", () => {
    const text = MemoryRecall.block([
      {
        scope: "project",
        facts: [
          { fact: fact("b", "Second fact."), score: 0.4 },
          { fact: fact("a", "The billing service owns the invoices table."), score: 0.1 },
        ],
        graph: "billing service -- owns -- invoices table",
      },
    ])!
    expect(text.startsWith("<memory>")).toBe(true)
    expect(text.endsWith("</memory>")).toBe(true)
    expect(text).toContain("not instructions")
    expect(text.indexOf("billing service owns")).toBeLessThan(text.indexOf("Second fact."))
    expect(text).toContain("[project memory, 2026-09-26, from user message, session ses_1, id a]")
    expect(text).toContain("billing service -- owns -- invoices table")
  })

  test("respects the token cap and returns nothing when nothing fits or matches", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      fact: fact(`f${i}`, `Fact number ${i} `.repeat(5)),
      score: i,
    }))
    const text = MemoryRecall.block([{ scope: "user", facts: many, graph: "" }], 300)!
    expect(text.length).toBeLessThanOrEqual(300 * 4)
    expect(MemoryRecall.block([{ scope: "user", facts: [], graph: "x" }])).toBe(undefined)
  })
})

describe("MemoryNotes", () => {
  test("one fact per paragraph, skipping headings", () => {
    expect(MemoryNotes.paragraphs("# Title\n\nFirst fact.\n\n## Sub\n\nSecond\nfact.\n\n---\n")).toEqual([
      "First fact.",
      "Second\nfact.",
    ])
  })

  test("sync remembers new paragraphs and forgets edited ones; the files stay the source of truth", async () => {
    await using tmp = await tmpdir()
    const notes = path.join(tmp.path, ".opencode", "memory")
    await fs.mkdir(notes, { recursive: true })
    await fs.writeFile(path.join(notes, "team.md"), "# Team\n\nBilling owns invoices.\n\nDeploys happen on Tuesdays.\n")

    const stored: MemoryStore.Fact[] = []
    const backend = {
      remember: async (text: string, provenance: MemoryStore.Provenance) => {
        const item = { id: `f${stored.length}`, datasetID: "d", text, provenance }
        stored.push(item)
        return item
      },
      forget: async (id: string) => {
        const index = stored.findIndex((item) => item.id === id)
        if (index >= 0) stored.splice(index, 1)
        return index >= 0
      },
      list: async () => [...stored],
    } as unknown as MemoryBackend.Backend

    await MemoryNotes.sync({ backend, worktree: tmp.path })
    expect(stored.map((item) => [item.text, item.provenance.source, item.provenance.agent])).toEqual([
      ["Billing owns invoices.", ".opencode/memory/team.md", "user"],
      ["Deploys happen on Tuesdays.", ".opencode/memory/team.md", "user"],
    ])

    await fs.writeFile(
      path.join(notes, "team.md"),
      "# Team\n\nBilling owns invoices.\n\nDeploys happen on Thursdays.\n",
    )
    await MemoryNotes.sync({ backend, worktree: tmp.path })
    expect(stored.map((item) => item.text)).toEqual(["Billing owns invoices.", "Deploys happen on Thursdays."])
  })
})
