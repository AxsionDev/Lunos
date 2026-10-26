// XCOD-303: Dynamic workflows, end to end on the session loop real sessions use (SessionPrompt.loop,
// the v1 path), against a scripted model served by TestLLMServer. The headline check is by agent:
// the main agent's own tool calls (and the tools its requests offer) never include edit, write or
// bash, while the subagents it dispatches do the work.
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { InstanceState } from "@/effect/instance-state"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DynamicWorkflows } from "@/session/workflows"
import { Budget } from "@/budget"
import type { SessionID } from "../../src/session/schema"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    overview: () => Effect.succeed({ enabled: true, downloads: true, servers: [] }),
    stop: () => Effect.void,
    log: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const model = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "test/test-model",
})

const managedDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!

/**
 * A session in `agent` mode with the given config. Background subagents are off so the scripted
 * replies are consumed in a fixed order (root, child, root, …).
 */
const setup = Effect.fn("test.setup")(function* (input: {
  agent: string
  config?: Partial<ConfigV1.Info>
  cursor?: { phase: string; gate: string }
  permission?: PermissionV1.Ruleset
}) {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fsys = yield* FSUtil.Service
  yield* fsys.writeWithDirs(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://lunos.tech/config.json",
      ...model(llm.url),
      subagent: { background: false },
      ...input.config,
    }),
  )
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "Dynamic workflows",
    permission: input.permission ?? [{ permission: "*", pattern: "*", action: "allow" }],
  })
  const file = Session.devcycle(session, yield* InstanceState.context)
  if (input.cursor)
    yield* fsys.writeWithDirs(
      file,
      `---\nphase: ${input.cursor.phase}\ngate: ${input.cursor.gate}\n---\n\n# Cycle\n\n## Plan\n\n1. Validate the signup form\n`,
    )
  return { session, llm, directory, file }
})

const say = Effect.fn("test.say")(function* (sessionID: SessionID, agent: string, text: string) {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({ sessionID, agent, noReply: true, parts: [{ type: "text", text }] })
})

const command = (sessionID: SessionID, args: string) =>
  SessionPrompt.Service.use((prompt) =>
    prompt.command({ sessionID, agent: "build", command: "workflows", arguments: args }),
  )

const run = (sessionID: SessionID) => SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID }))

/** Model requests, without the title request the server answers by itself. */
const modelCalls = Effect.fn("test.modelCalls")(function* () {
  const llm = yield* TestLLMServer
  return (yield* llm.inputs).filter((body) => !JSON.stringify(body).includes("Generate a title"))
})

/** The tool names a request offered the model. */
const offered = (body: Record<string, unknown>) =>
  ((body.tools ?? []) as { function?: { name?: string }; name?: string }[]).map(
    (tool) => tool.function?.name ?? tool.name ?? "",
  )

const exists = (file: string) =>
  Effect.promise(() =>
    fs
      .access(file)
      .then(() => true)
      .catch(() => false),
  )

/** Every tool call in a session tree, with the session and agent that made it. */
const toolCallsByAgent = Effect.fn("test.toolCallsByAgent")(function* (rootID: SessionID) {
  const sessions = yield* Session.Service
  const calls: { session: string; agent: string; tool: string; status: string; error?: string }[] = []
  const queue: SessionID[] = [rootID]
  while (queue.length) {
    const id = queue.shift()!
    const msgs = yield* MessageV2.filterCompactedEffect(id)
    for (const msg of msgs) {
      if (msg.info.role !== "assistant") continue
      for (const part of msg.parts)
        if (part.type === "tool")
          calls.push({
            session: id,
            agent: msg.info.agent,
            tool: part.tool,
            status: part.state.status,
            ...(part.state.status === "error" ? { error: part.state.error } : {}),
          })
    }
    for (const child of yield* sessions.children(id)) queue.push(child.id)
  }
  return calls
})

const WRITERS = ["edit", "write", "apply_patch", "bash"]

describe("Dynamic workflows on the live loop (XCOD-303)", () => {
  it.instance("default config: the main agent dispatches; only subagents edit, write or run commands", () =>
    Effect.gen(function* () {
      const { session, llm, directory } = yield* setup({ agent: "build" })
      const source = path.join(directory, "signup.ts")
      const built = path.join(directory, "built.txt")
      yield* say(session.id, "build", "Add input validation and tests to the signup form.")
      // Root: dispatch the builder.
      yield* llm.tool("task", {
        description: "implement validation",
        prompt: "Add validation to signup.ts and run the build. Report what you changed.",
        subagent_type: "general",
      })
      // Builder (general): writes the file, runs a command, reports.
      yield* llm.tool("write", { filePath: source, content: "export const valid = (s: string) => s.length > 0\n" })
      yield* llm.tool("bash", { command: `echo built > ${built}`, description: "build", workdir: directory })
      yield* llm.text("Added validation in signup.ts; the build passed.")
      // Root: dispatch qa, a different subagent.
      yield* llm.tool("task", {
        description: "verify validation",
        prompt: "Check signup.ts and run the tests. End with a Verification block.",
        subagent_type: "qa",
      })
      // qa: runs a command, reports a Verification block.
      yield* llm.tool("bash", { command: `cat ${source}`, description: "check", workdir: directory })
      yield* llm.text("Verification\n✓ signup.ts validates input")
      // Root: integrates and hands back.
      yield* llm.text("Validation added.\n\nVerification\n✓ signup.ts validates input")

      yield* run(session.id)

      const calls = yield* toolCallsByAgent(session.id)
      const mine = calls.filter((call) => call.session === session.id)
      // The main agent's own calls: dispatching only, and nothing outside the coordination set.
      expect(mine.map((call) => call.tool)).toEqual(["task", "task"])
      for (const call of mine) expect(DynamicWorkflows.ALLOWED.has(call.tool)).toBe(true)
      expect(mine.some((call) => WRITERS.includes(call.tool))).toBe(false)
      // The work was done by subagents: the builder wrote and ran, qa (another session) ran.
      const builder = calls.filter((call) => call.agent === "general")
      const qa = calls.filter((call) => call.agent === "qa")
      expect(builder.map((call) => [call.tool, call.status])).toEqual([
        ["write", "completed"],
        ["bash", "completed"],
      ])
      expect(qa.map((call) => [call.tool, call.status])).toEqual([["bash", "completed"]])
      expect(builder[0].session).not.toBe(qa[0].session)
      expect(builder[0].session).not.toBe(session.id)
      expect(yield* exists(source)).toBe(true)
      expect(yield* exists(built)).toBe(true)

      // Gated, not just a polite script: the main agent's requests never offered a writing tool,
      // and told it to orchestrate; the builder's did offer them.
      const requests = yield* modelCalls()
      expect(requests).toHaveLength(8)
      for (const index of [0, 4, 7]) {
        const tools = offered(requests[index])
        expect(tools).toContain("task")
        expect(tools).toContain("read")
        for (const name of WRITERS) expect(tools).not.toContain(name)
      }
      expect(JSON.stringify(requests[0])).toContain("Dynamic workflows are on. You are the orchestrator")
      expect(offered(requests[1])).toContain("bash")
      expect(offered(requests[1])).toContain("write")
      // qa is told how to verify and to end with the Verification block; the orchestrator isn't.
      expect(JSON.stringify(requests[5])).toContain("# Verify with proof")
      expect(JSON.stringify(requests[0])).not.toContain("# Finish with proof")
      expect(yield* llm.pending).toBe(0)
    }),
  )

  it.instance("a bash call from the main agent never runs", () =>
    Effect.gen(function* () {
      const { session, llm, directory } = yield* setup({ agent: "build" })
      const marker = path.join(directory, "should-not-exist.txt")
      yield* say(session.id, "build", "Create the marker file.")
      yield* llm.tool("bash", { command: `echo no > ${marker}`, description: "write", workdir: directory })
      yield* llm.text("I can't run commands; I'll dispatch a subagent next time.")

      yield* run(session.id)

      expect(yield* exists(marker)).toBe(false)
      const mine = (yield* toolCallsByAgent(session.id)).filter((call) => call.session === session.id)
      expect(mine.some((call) => call.tool === "bash" && call.status === "completed")).toBe(false)
    }),
  )

  it.instance("/workflows off makes the main agent do the work itself in the same session", () =>
    Effect.gen(function* () {
      const { session, llm, directory } = yield* setup({ agent: "build" })
      const marker = path.join(directory, "done.txt")

      yield* command(session.id, "off")
      const sessions = yield* Session.Service
      expect((yield* sessions.get(session.id)).metadata).toMatchObject({ workflows: { dynamic: false } })

      yield* say(session.id, "build", "Create the marker file.")
      yield* llm.tool("bash", { command: `echo yes > ${marker}`, description: "write", workdir: directory })
      yield* llm.text("Created done.txt.")
      yield* run(session.id)

      expect(yield* exists(marker)).toBe(true)
      const [first] = yield* modelCalls()
      expect(offered(first)).toContain("bash")
      expect(JSON.stringify(first)).not.toContain("You are the orchestrator")

      // And back on: the next turn is gated again.
      yield* command(session.id, "on")
      yield* say(session.id, "build", "Again.")
      yield* llm.text("ok")
      yield* run(session.id)
      const calls = yield* modelCalls()
      expect(offered(calls.at(-1)!)).not.toContain("bash")
    }),
  )

  it.instance('"workflows": { "dynamic": false } in config: the main agent works directly', () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "build", config: { workflows: { dynamic: false } } })
      yield* say(session.id, "build", "Hi")
      yield* llm.text("Hello")
      yield* run(session.id)
      const [first] = yield* modelCalls()
      expect(offered(first)).toContain("bash")
    }),
  )

  it.instance("an organisation lock holds over project config, and /workflows can't override it", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      yield* fsys.writeWithDirs(
        path.join(managedDir, "opencode.json"),
        JSON.stringify({ $locked: ["workflows.dynamic"], workflows: { dynamic: true } }),
      )
      yield* Effect.addFinalizer(() => fsys.remove(path.join(managedDir, "opencode.json")).pipe(Effect.ignore))
      const { session, llm } = yield* setup({ agent: "build", config: { workflows: { dynamic: false } } })

      const result = yield* command(session.id, "off")
      const text = result.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      expect(text).toContain("Can't turn Dynamic workflows off")
      expect(text).toContain("set by your organisation's policy")
      const sessions = yield* Session.Service
      expect(DynamicWorkflows.sessionValue((yield* sessions.get(session.id)).metadata)).toBeUndefined()

      yield* say(session.id, "build", "Hi")
      yield* llm.text("Hello")
      yield* run(session.id)
      const [first] = yield* modelCalls()
      expect(offered(first)).not.toContain("bash")
    }),
  )

  it.instance("a plain question is answered directly, without dispatching", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "build" })
      yield* say(session.id, "build", "What does the valid() helper return for an empty string?")
      yield* llm.text("false: it checks the length is above zero.")
      yield* run(session.id)
      expect(yield* modelCalls()).toHaveLength(1)
      expect(yield* toolCallsByAgent(session.id)).toEqual([])
    }),
  )

  it.instance(
    "Dev-Cycle: the build phase goes to a builder, qa is another subagent, the main agent edits only its cycle file",
    () =>
      Effect.gen(function* () {
        const { session, llm, directory, file } = yield* setup({
          agent: "dev-cycle",
          cursor: { phase: "build", gate: "approved" },
        })
        const source = path.join(directory, "signup.ts")
        yield* say(session.id, "dev-cycle", "Approved.")
        // The main agent records progress in its cycle file (allowed), then tries the code (refused).
        yield* llm.tool("write", {
          filePath: file,
          content: "---\nphase: build\ngate: approved\n---\n\n# Cycle\n\n## Build\n\nDispatching the builder.\n",
        })
        yield* llm.tool("write", { filePath: source, content: "nope\n" })
        yield* llm.tool("task", {
          description: "build step 1",
          prompt: "Implement: 1. Validate the signup form, in signup.ts.",
          subagent_type: "general",
        })
        yield* llm.tool("write", { filePath: source, content: "export const valid = true\n" })
        yield* llm.text("Implemented step 1.")
        yield* llm.tool("task", { description: "verify build", prompt: "Review signup.ts.", subagent_type: "qa" })
        yield* llm.text("Verification\n✓ signup.ts reviewed")
        yield* llm.text("Built and verified.")

        yield* run(session.id)

        const calls = yield* toolCallsByAgent(session.id)
        const mine = calls.filter((call) => call.session === session.id)
        expect(mine.map((call) => [call.tool, call.status])).toEqual([
          ["write", "completed"],
          ["write", "error"],
          ["task", "completed"],
          ["task", "completed"],
        ])
        expect(mine[1].error).toContain(DynamicWorkflows.REFUSAL)
        expect(mine.some((call) => call.tool === "bash")).toBe(false)
        expect(yield* Effect.promise(() => fs.readFile(source, "utf8"))).toBe("export const valid = true\n")
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("Dispatching the builder.")
        // The code was written by the builder; qa ran in a session of its own.
        const sessions = yield* Session.Service
        const children = yield* sessions.children(session.id)
        expect(children.map((child) => child.agent).toSorted()).toEqual(["general", "qa"])
        const builder = children.find((child) => child.agent === "general")!
        expect(calls.filter((call) => call.session === builder.id).map((call) => [call.tool, call.status])).toEqual([
          ["write", "completed"],
        ])

        const [first] = yield* modelCalls()
        expect(JSON.stringify(first)).toContain("dispatch a builder subagent")
        expect(offered(first)).not.toContain("bash")
      }),
  )

  it.instance("a step re-dispatched 3 times is not dispatched again without the user", () =>
    Effect.gen(function* () {
      // No one to ask (`lunos run` denies the question tool): the fourth re-dispatch is refused.
      const { session, llm } = yield* setup({
        agent: "build",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "question", pattern: "*", action: "deny" },
        ],
      })
      yield* say(session.id, "build", "Fix the flaky test.")
      const step = { description: "fix flaky test", prompt: "Fix it.", subagent_type: "general" }
      for (let i = 0; i < 4; i++) {
        yield* llm.tool("task", step)
        yield* llm.text("Still failing.")
      }
      yield* llm.tool("task", step)
      yield* llm.text("The step failed 4 times; over to you.")

      yield* run(session.id)

      const mine = (yield* toolCallsByAgent(session.id)).filter((call) => call.session === session.id)
      expect(mine.map((call) => call.status)).toEqual(["completed", "completed", "completed", "completed", "error"])
      expect(mine[4].error).toContain("re-dispatched 3 times")
      const sessions = yield* Session.Service
      expect(yield* sessions.children(session.id)).toHaveLength(4)
      expect(yield* llm.pending).toBe(0)
    }),
  )

  it.instance("budget on_limit: stop: no new subagent is dispatched once the budget is used", () =>
    Effect.gen(function* () {
      const fsys = yield* FSUtil.Service
      yield* fsys.writeWithDirs(
        path.join(managedDir, "opencode.json"),
        JSON.stringify({
          $locked: ["budget"],
          budget: { on_limit: "stop", organisation: { amount: 1, period: "total" } },
        }),
      )
      Budget.reset()
      yield* Effect.addFinalizer(() =>
        fsys
          .remove(path.join(managedDir, "opencode.json"))
          .pipe(Effect.ignore, Effect.andThen(Effect.sync(() => Budget.reset()))),
      )
      const { session, llm } = yield* setup({ agent: "build" })
      yield* say(session.id, "build", "Add validation.")
      // The root's dispatch is held until another step (simulated) has used the budget up.
      const release = { resolve: () => {} }
      const held = new Promise<void>((resolve) => (release.resolve = resolve))
      yield* llm.push(
        reply().wait(held).tool("task", { description: "implement", prompt: "Do it.", subagent_type: "general" }),
      )
      const loop = yield* run(session.id).pipe(Effect.forkChild)
      yield* llm.wait(1)
      Budget.spent(session.id, 10)
      release.resolve()
      yield* Fiber.join(loop)

      const mine = (yield* toolCallsByAgent(session.id)).filter((call) => call.session === session.id)
      expect(mine.map((call) => [call.tool, call.status])).toEqual([["task", "error"]])
      expect(mine[0].error).toContain("No new subagent is dispatched")
      const sessions = yield* Session.Service
      expect(yield* sessions.children(session.id)).toHaveLength(0)
    }),
  )
})
