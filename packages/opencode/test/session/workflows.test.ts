// XCOD-303: the Dynamic workflows switch, its precedence, and the main agent's tool gate.
import { describe, expect, test } from "bun:test"
import { DynamicWorkflows } from "@/session/workflows"
import { Permission } from "@/permission"
import { AuditLog } from "@/audit/log"
import { Audit } from "@opencode-ai/core/audit"
import fs from "fs/promises"
import os from "os"
import path from "path"

const allow = Permission.fromConfig({ "*": "allow" })
const build = { name: "build", permission: allow }
const general = { name: "general", permission: allow }
const explore = { name: "explore", permission: Permission.fromConfig({ "*": "deny", read: "allow" }) }

describe("DynamicWorkflows.setting / decide", () => {
  test("on by default", () => {
    expect(DynamicWorkflows.setting({ config: {} })).toMatchObject({ on: true, by: "default", locked: false })
  })

  test("config, then the session, then an organisation lock", () => {
    expect(DynamicWorkflows.setting({ config: { workflows: { dynamic: false } } })).toMatchObject({
      on: false,
      by: "config",
    })
    expect(DynamicWorkflows.setting({ config: { workflows: { dynamic: false } }, session: true })).toMatchObject({
      on: true,
      by: "session",
    })
    const locked = { $locked: ["workflows.dynamic"], workflows: { dynamic: false } }
    expect(DynamicWorkflows.setting({ config: locked, session: true })).toMatchObject({
      on: false,
      by: "lock",
      locked: true,
    })
    // A lock on the whole `workflows` key covers it too; unset under a lock is the default (on).
    expect(DynamicWorkflows.setting({ config: { $locked: ["workflows"] }, session: false })).toMatchObject({
      on: true,
      by: "lock",
    })
  })

  test("only a top-level Build or Dev-Cycle session runs it", () => {
    const base = { config: {}, subagents: [general] }
    expect(DynamicWorkflows.decide({ ...base, agent: build, session: {} }).on).toBe(true)
    expect(DynamicWorkflows.decide({ ...base, agent: { ...build, name: "dev-cycle" }, session: {} }).on).toBe(true)
    expect(DynamicWorkflows.decide({ ...base, agent: { ...build, name: "plan" }, session: {} }).by).toBe("mode")
    expect(DynamicWorkflows.decide({ ...base, agent: build, session: { parentID: "ses_parent" } }).by).toBe("mode")
  })

  test("XCOD-326: every top-level primary agent but Plan runs it; an agent opts out with dynamic: false", () => {
    const base = { config: {}, subagents: [general], session: {} }
    for (const agent of [
      { ...build, name: "research", mode: "primary" },
      { ...build, name: "reviewer", mode: "primary" },
      { ...build, name: "mine", mode: "all" },
    ])
      expect(DynamicWorkflows.decide({ ...base, agent }).on).toBe(true)
    expect(DynamicWorkflows.decide({ ...base, agent: { ...build, name: "helper", mode: "subagent" } }).by).toBe("mode")
    expect(DynamicWorkflows.decide({ ...base, agent: { ...build, name: "title", hidden: true } }).by).toBe("mode")
    const optOut = { agent: { reviewer: { dynamic: false } } }
    const reviewer = { ...build, name: "reviewer", mode: "primary" }
    expect(DynamicWorkflows.decide({ ...base, config: optOut, agent: reviewer })).toMatchObject({
      on: false,
      by: "agent",
    })
    // /workflows on in the session, and an organisation lock, still win over the agent's opt-out.
    expect(
      DynamicWorkflows.decide({
        ...base,
        config: optOut,
        agent: reviewer,
        session: { metadata: { workflows: { dynamic: true } } },
      }).on,
    ).toBe(true)
    expect(
      DynamicWorkflows.decide({ ...base, config: { ...optOut, $locked: ["workflows.dynamic"] }, agent: reviewer }).on,
    ).toBe(true)
    // Opting out is per agent: Build stays on.
    expect(DynamicWorkflows.decide({ ...base, config: optOut, agent: build }).on).toBe(true)
  })

  test("XCOD-326: off for want of a writing subagent says why and how to fix it", () => {
    const depth = DynamicWorkflows.decide({
      config: { subagent_depth: 0 },
      agent: build,
      session: {},
      subagents: [general],
    })
    expect(DynamicWorkflows.notice(depth)).toBe(
      `Dynamic workflows are off for this session: "subagent_depth" is 0, so no subagent can be dispatched. Fix: set "subagent_depth" to 1 or more. The main agent does the work itself until then. See ${DynamicWorkflows.DOCS}`,
    )
    const denied = { name: "build", permission: Permission.merge(allow, Permission.fromConfig({ task: "deny" })) }
    expect(
      DynamicWorkflows.notice(
        DynamicWorkflows.decide({ config: {}, agent: denied, session: {}, subagents: [general] }),
      ),
    ).toContain('Fix: allow "task"')
    expect(
      DynamicWorkflows.notice(DynamicWorkflows.decide({ config: {}, agent: build, session: {}, subagents: [explore] })),
    ).toContain("every subagent it may dispatch has edit turned off")
    // Off by choice, or on: no notice.
    expect(
      DynamicWorkflows.notice(DynamicWorkflows.setting({ config: { workflows: { dynamic: false } } })),
    ).toBeUndefined()
    expect(
      DynamicWorkflows.notice(DynamicWorkflows.decide({ config: {}, agent: build, session: {}, subagents: [general] })),
    ).toBeUndefined()
  })

  test("falls back to off when no subagent that can edit may be dispatched", () => {
    expect(DynamicWorkflows.decide({ config: {}, agent: build, session: {}, subagents: [explore] }).by).toBe(
      "subagents",
    )
    // subagent_depth 0: no task call can start a subagent at all.
    expect(
      DynamicWorkflows.decide({ config: { subagent_depth: 0 }, agent: build, session: {}, subagents: [general] }).by,
    ).toBe("subagents")
    const denied = { name: "build", permission: Permission.merge(allow, Permission.fromConfig({ task: "deny" })) }
    expect(DynamicWorkflows.decide({ config: {}, agent: denied, session: {}, subagents: [general] }).on).toBe(false)
  })

  test("/workflows on|off is kept in session metadata, beside other keys", () => {
    const meta = DynamicWorkflows.withSessionValue({ subagent: { queued: true } }, false)
    expect(meta).toEqual({ subagent: { queued: true }, workflows: { dynamic: false } })
    expect(DynamicWorkflows.sessionValue(meta)).toBe(false)
    expect(DynamicWorkflows.sessionValue(DynamicWorkflows.withSessionValue(meta, undefined))).toBeUndefined()
  })
})

describe("DynamicWorkflows.gate", () => {
  const tools = () =>
    Object.fromEntries(
      ["read", "grep", "glob", "task", "todowrite", "question", "edit", "write", "apply_patch", "bash", "process"]
        .concat(["mcp_server_tool", "execute", "external_agent", "webfetch", "invalid"])
        .map((name) => [name, { execute: async (_args: unknown, _options: unknown) => name }]),
    )

  test("drops everything but coordination tools", () => {
    const set = tools()
    const dropped = DynamicWorkflows.gate(set, { directory: "/work" })
    expect(Object.keys(set).toSorted()).toEqual(["glob", "grep", "invalid", "question", "read", "task", "todowrite"])
    expect(dropped).toContain("bash")
    expect(dropped).toContain("mcp_server_tool")
  })

  test("Dev-Cycle keeps its edit tools for the cycle file only", async () => {
    const set = tools()
    DynamicWorkflows.gate(set, { directory: "/work", allowFile: "/data/dev-cycle/cycle.md" })
    expect(Object.keys(set)).toContain("write")
    expect(Object.keys(set)).not.toContain("bash")
    expect(await set.write!.execute!({ filePath: "/data/dev-cycle/cycle.md" }, {})).toBe("write")
    expect(() => set.write!.execute!({ filePath: "src/app.ts" }, {})).toThrow(DynamicWorkflows.REFUSAL)
    expect(() =>
      set.apply_patch!.execute!(
        { patchText: "*** Begin Patch\n*** Update File: /data/dev-cycle/cycle.md\n*** Add File: src/x.ts\n" },
        {},
      ),
    ).toThrow(DynamicWorkflows.REFUSAL)
  })
})

describe("DynamicWorkflows read budget and refusals (XCOD-326)", () => {
  const tools = () =>
    Object.fromEntries(
      [
        "read",
        "grep",
        "glob",
        "lsp",
        "read_mcp_resource",
        "task",
        "todowrite",
        "question",
        "invalid",
        "bash",
        "edit",
      ].map((name) => [name, { execute: async (_args: unknown, _options: unknown) => name }]),
    )

  test("reads, searches, lsp and resource reads share one budget; coordination tools are unlimited", async () => {
    const set = tools()
    DynamicWorkflows.gate(set, { directory: "/work", reads: { used: 2, limit: 5 } })
    expect(await set.read!.execute!({}, {})).toBe("read")
    expect(await set.grep!.execute!({}, {})).toBe("grep")
    expect(await set.lsp!.execute!({}, {})).toBe("lsp")
    expect(() => set.read_mcp_resource!.execute!({}, {})).toThrow("dispatch an explore subagent")
    expect(() => set.glob!.execute!({}, {})).toThrow("dispatch an explore subagent")
    for (let i = 0; i < 10; i++) {
      expect(await set.task!.execute!({}, {})).toBe("task")
      expect(await set.todowrite!.execute!({}, {})).toBe("todowrite")
    }
  })

  test("the turn starts at the last message the user typed", () => {
    const tool = (name: string) => ({ type: "tool", tool: name })
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "old" }] },
      { info: { role: "assistant" }, parts: [tool("read"), tool("read")] },
      { info: { role: "user" }, parts: [{ type: "text", text: "now" }] },
      { info: { role: "assistant" }, parts: [tool("grep"), tool("task"), tool("lsp")] },
      // An auto-continue is synthetic: still the same turn.
      { info: { role: "user" }, parts: [{ type: "text", text: "Continue.", synthetic: true }] },
      { info: { role: "assistant" }, parts: [tool("read"), tool("todowrite")] },
    ]
    expect(DynamicWorkflows.readsUsed(messages)).toBe(3)
  })

  test("a call to a dropped tool is refused and audited", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-workflows-"))
    const file = path.join(dir, "audit.log")
    AuditLog.activate({ enabled: true, file, redact: [] })
    try {
      const set = tools()
      DynamicWorkflows.gate(set, { directory: "/work", session: "ses_main", agent: "build" })
      expect(Object.keys(set)).not.toContain("bash")
      expect(() => set.invalid!.execute!({ tool: "Bash", error: "There is no tool named" }, {})).toThrow(
        DynamicWorkflows.REFUSAL,
      )
      // A made-up tool name is no refusal: it still gets the usual answer.
      expect(await set.invalid!.execute!({ tool: "frobnicate", error: "There is no tool named" }, {})).toBe("invalid")
      await AuditLog.flush()
      const lines = (await fs.readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === "workflows.main_tool_refused" && line.session === "ses_main")
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        tool: "bash",
        agent: "build",
        session: "ses_main",
      })
    } finally {
      AuditLog.activate({ enabled: false, file, redact: [] })
      await fs.rm(dir, { recursive: true, force: true })
    }
    expect(Audit.EVENTS as readonly string[]).toContain("workflows.main_tool_refused")
  })
})

describe("DynamicWorkflows.dispatches", () => {
  const task = (input: Record<string, unknown>, sessionId?: string) => ({
    type: "tool",
    tool: "task",
    state: { input, metadata: sessionId ? { sessionId } : {} },
  })
  const messages = [
    { info: { role: "assistant" }, parts: [task({ subagent_type: "general", description: "fix" }, "ses_1")] },
    { info: { role: "assistant" }, parts: [task({ subagent_type: "general", description: "fix", task_id: "ses_1" })] },
    { info: { role: "assistant" }, parts: [task({ subagent_type: "general", description: "docs" }, "ses_2")] },
  ]

  test("counts a step by task_id, or by agent type and description", () => {
    expect(
      DynamicWorkflows.dispatches(messages, { subagent_type: "general", description: "x", task_id: "ses_1" }),
    ).toBe(2)
    expect(DynamicWorkflows.dispatches(messages, { subagent_type: "general", description: "docs" })).toBe(1)
    expect(DynamicWorkflows.dispatches(messages, { subagent_type: "qa", description: "fix" })).toBe(0)
  })
})
