// XCOD-303: the Dynamic workflows switch, its precedence, and the main agent's tool gate.
import { describe, expect, test } from "bun:test"
import { DynamicWorkflows } from "@/session/workflows"
import { Permission } from "@/permission"

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
