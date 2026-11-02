// XCOD-254: what the bridge lists and how a memory or skill call runs, against stub services: memory
// tools only while memory is on, a fact refused after the tool fetched from the web, and every call
// through permission, hooks and the audit log.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ExternalBridgeTools } from "../../src/external/bridge-tools"

function stubs(options: { memory: boolean; parts?: string[] }) {
  const asked: { permission: string; patterns: readonly string[] }[] = []
  const hooks: string[] = []
  const remembered: string[] = []
  const messages = [
    { info: { id: "msg_u", role: "user", sessionID: "ses" }, parts: [{ type: "text", text: "remember it" }] },
    {
      info: { id: "msg_a", role: "assistant", sessionID: "ses" },
      parts: (options.parts ?? []).map((tool) => ({ type: "tool", tool, state: { status: "completed", input: {} } })),
    },
  ] as unknown as SessionV1.WithParts[]
  const input = {
    tool: "claude" as const,
    sessionID: "ses_1" as any,
    agent: "build",
    ruleset: [{ permission: "*", pattern: "*", action: "allow" as const }],
    config: { model: "anthropic/claude-sonnet-5-5" },
    worktree: "/work",
    settle: async () => undefined,
    pending: new Set<any>(),
    run: { promise: <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect) } as any,
    sessions: { messages: () => Effect.succeed(messages) } as any,
    permission: {
      ask: (request: any) =>
        Effect.sync(() => {
          asked.push({ permission: request.permission, patterns: request.patterns })
        }),
    } as any,
    mcp: { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) } as any,
    plugin: {
      trigger: (name: string, _input: unknown, output: unknown) =>
        Effect.sync(() => {
          hooks.push(name)
          return output
        }),
    } as any,
    memory: {
      decision: () => Effect.succeed({ on: options.memory }),
      target: () => Effect.succeed({ type: "embedded", readOnly: false }),
      scopes: () => Effect.succeed(["project"]),
      search: () => Effect.succeed([]),
      remember: (request: { fact: string }) =>
        Effect.sync(() => {
          remembered.push(request.fact)
          return { id: "fact_1" }
        }),
    } as any,
    skill: {
      available: () =>
        Effect.succeed([
          { name: "deploy", description: "How to deploy", location: "/skills/deploy/SKILL.md", content: "Do it." },
        ]),
    } as any,
  }
  return { tools: ExternalBridgeTools.make(input), asked, hooks, remembered }
}

describe("ExternalBridgeTools.make", () => {
  test("memory tools are listed only while memory is on", async () => {
    const on = await stubs({ memory: true }).tools.engine.list()
    expect(on.map((tool) => tool.name)).toEqual([
      "lunos_skill_list",
      "lunos_skill_load",
      "lunos_memory_search",
      "lunos_memory_remember",
    ])
    const off = await stubs({ memory: false }).tools.engine.list()
    expect(off.map((tool) => tool.name)).toEqual(["lunos_skill_list", "lunos_skill_load"])
    expect(await Effect.runPromise(stubs({ memory: true }).tools.status())).toEqual({
      servers: 0,
      skills: 1,
      memory: true,
    })
  })

  test("remember asks for memory and stores the fact; it's refused after a web fetch, before anyone is asked", async () => {
    const clean = stubs({ memory: true, parts: ["claude:Edit"] })
    const stored = await clean.tools.engine.call("lunos_memory_remember", {
      fact: "Tests run with bun test",
      source: "user message",
    })
    expect(stored.isError).toBeUndefined()
    expect(clean.remembered).toEqual(["Tests run with bun test"])
    expect(clean.asked).toEqual([{ permission: "memory", patterns: ["project"] }])
    expect(clean.hooks).toEqual(["tool.execute.before", "tool.execute.after"])

    const tainted = stubs({ memory: true, parts: ["claude:WebFetch"] })
    const refused = await tainted.tools.engine.call("lunos_memory_remember", { fact: "x is y", source: "user message" })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]).toMatchObject({ text: expect.stringContaining("claude:WebFetch") })
    expect(tainted.remembered).toEqual([])
    expect(tainted.asked).toEqual([])
  })

  test("search and the skill list ask too, and a tool that isn't offered is refused", async () => {
    const { tools, asked, hooks } = stubs({ memory: true })
    const search = await tools.engine.call("lunos_memory_search", { query: "tests" })
    expect(search.content[0]).toMatchObject({ text: expect.stringContaining("Lunos memory") })
    const list = await tools.engine.call("lunos_skill_list", {})
    expect(list.content[0]).toMatchObject({ text: expect.stringContaining("- deploy: How to deploy") })
    expect(asked).toEqual([
      { permission: "memory", patterns: ["search"] },
      { permission: "skill", patterns: ["*"] },
    ])
    expect(hooks.length).toBe(4)
    const unknown = await tools.engine.call("lunos__other__tool", {})
    expect(unknown.isError).toBe(true)
  })
})
