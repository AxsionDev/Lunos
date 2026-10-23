// XCOD-302: Dev-Cycle (and Build) never stall between gates. End to end on the session loop real
// sessions use (SessionPrompt.loop, the v1 path), against a scripted model served by TestLLMServer:
// each test scripts every model turn it relies on, so an unexpected extra request shows up in the
// call count rather than passing on the server's default "ok".
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer } from "effect"
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
import { AutoContinue } from "@/session/auto-continue"
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

/** A session in `agent` mode, the given config, and (for Dev-Cycle) a cycle file at `cursor`. */
const setup = Effect.fn("test.setup")(function* (input: {
  agent: string
  cursor?: { phase: string; gate: string }
  config?: Partial<ConfigV1.Info>
}) {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(directory, "opencode.json"),
    JSON.stringify({ $schema: "https://lunos.tech/config.json", ...model(llm.url), ...input.config }),
  )
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "Auto-continue",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  const file = Session.devcycle(session, yield* InstanceState.context)
  if (input.cursor)
    yield* fs.writeWithDirs(
      file,
      `---\nphase: ${input.cursor.phase}\ngate: ${input.cursor.gate}\n---\n\n# Cycle\n\n## Plan\n\n1. Host vertical slice\n`,
    )
  return { session, llm, file }
})

const say = Effect.fn("test.say")(function* (sessionID: SessionID, agent: string, text: string) {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({ sessionID, agent, noReply: true, parts: [{ type: "text", text }] })
})

const run = (sessionID: SessionID) => SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID }))

/** Model requests, without the title request the server answers by itself. */
const modelCalls = Effect.fn("test.modelCalls")(function* () {
  const llm = yield* TestLLMServer
  return (yield* llm.inputs).filter((body) => !JSON.stringify(body).includes("Generate a title"))
})

const history = (sessionID: SessionID) => MessageV2.filterCompactedEffect(sessionID)

const continuations = (msgs: SessionV1.WithParts[]) => msgs.filter(AutoContinue.isContinuation)

const userMessages = (msgs: SessionV1.WithParts[]) => msgs.filter((msg) => msg.info.role === "user")

const label = (msg: SessionV1.WithParts) =>
  msg.parts.flatMap((part) =>
    part.type === "text" && part.metadata?.[AutoContinue.METADATA] ? [part.metadata[AutoContinue.METADATA]] : [],
  )[0] as { label: string; attempt: number } | undefined

const completedTools = (msgs: SessionV1.WithParts[], tool: string) =>
  msgs.flatMap((msg) =>
    msg.parts.filter(
      (part): part is SessionV1.ToolPart =>
        part.type === "tool" && part.tool === tool && part.state.status === "completed",
    ),
  )

const waitForQuestion = Effect.gen(function* () {
  const question = yield* Question.Service
  for (;;) {
    const [item] = yield* question.list()
    if (item) return item
    yield* Effect.sleep("20 millis")
  }
}).pipe(Effect.timeout("10 seconds"))

// Three recorded model behaviours for "plan approved, then the turn ends announcing the build".
// None of them needs the user to type "proceed".
type Server = Context.Service.Shape<typeof TestLLMServer>
const behaviours = [
  {
    name: "fast (announces and stops, no tool call)",
    stall: (llm: Server) =>
      llm.text("Plan approved. Next I'll implement the IIS-deployable host vertical slice and verify it."),
  },
  {
    name: "standard (updates the cycle file, then announces)",
    stall: (llm: Server) =>
      Effect.gen(function* () {
        yield* llm.tool("glob", { pattern: "**/*.md" })
        yield* llm.text("Gate 2 is approved and recorded. I'll now start on step 1 of the plan.")
      }),
  },
  {
    name: "reasoning (thinks, then announces)",
    stall: (llm: Server) =>
      llm.reason("The plan is approved, so the build phase starts with step 1.", {
        text: "Moving on to the build phase: I'll implement step 1 now.",
      }),
  },
]

describe("Dev-Cycle auto-continue on the live loop (XCOD-302)", () => {
  for (const behaviour of behaviours) {
    it.instance(`${behaviour.name}: continues into the build without "proceed"`, () =>
      Effect.gen(function* () {
        const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "build", gate: "approved" } })
        yield* say(session.id, "dev-cycle", "Approved.")
        yield* behaviour.stall(llm)
        // The continuation's first move is a tool call, then the turn ends with a finished step.
        yield* llm.tool("glob", { pattern: "**/*" })
        yield* llm.text("Step 1 is built and its tests pass.")

        yield* run(session.id)

        const msgs = yield* history(session.id)
        const sent = continuations(msgs)
        expect(sent).toHaveLength(1)
        expect(label(sent[0])).toEqual({
          label: "Dev-Cycle continued automatically (plan approved → build)",
          attempt: 1,
        })
        // Only the human's message and Lunos's continuation: nobody typed "proceed".
        expect(userMessages(msgs)).toHaveLength(2)
        // The model was told to continue, and the continuation started with a tool call that ran.
        const calls = yield* modelCalls()
        const after = calls.findIndex((body) => JSON.stringify(body).includes("Continue the current phase now"))
        expect(after).toBeGreaterThan(0)
        expect(JSON.stringify(calls[after])).toContain("Continue the current phase now")
        const continued = msgs.filter((msg) => msg.info.role === "assistant" && msg.info.parentID === sent[0].info.id)
        expect(completedTools(continued, "glob").length).toBeGreaterThan(0)
        expect(calls).toHaveLength(after + 2)
        expect(yield* llm.pending).toBe(0)
      }),
    )
  }

  it.instance("an approval typed in reply to a dismissed gate question lets it continue past that gate", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "plan", gate: "pending" } })
      const question = yield* Question.Service
      // Turn 1: the gate is put to the human, who dismisses the card and types instead.
      yield* say(session.id, "dev-cycle", "Write the plan.")
      yield* llm.tool("question", {
        questions: [
          { header: "Gate 2", question: "Approve the plan?", options: [{ label: "Approve", description: "Build" }] },
        ],
      })
      const first = yield* run(session.id).pipe(Effect.forkScoped)
      yield* question.reject((yield* waitForQuestion).id)
      yield* Fiber.join(first)

      // Turn 2: "approved", and the model stalls instead of building.
      yield* say(session.id, "dev-cycle", "approved")
      yield* llm.text("Plan approved. Next I'll implement the host vertical slice.")
      yield* llm.tool("glob", { pattern: "**/*" })
      yield* llm.text("Step 1 is built.")
      yield* run(session.id)

      const msgs = yield* history(session.id)
      expect(label(continuations(msgs)[0])?.label).toBe("Dev-Cycle continued automatically (plan approved → build)")
      const calls = yield* modelCalls()
      expect(calls).toHaveLength(4)
      // The model is told to record the approval in the cycle file first.
      expect(JSON.stringify(calls[2])).toContain("advance `phase:` to build")
    }),
  )

  it.instance('"proceed" in the middle of a gated phase is a nudge, not an approval of its gate', () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "architect", gate: "pending" } })
      yield* say(session.id, "dev-cycle", "Design it.")
      yield* llm.text("Next I'll dispatch the architect subagent.")
      yield* run(session.id)
      yield* say(session.id, "dev-cycle", "proceed")
      yield* llm.text("Next I'll dispatch the architect subagent.")
      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(2)
    }),
  )

  it.instance("an approval picked in the question tool counts too", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "plan", gate: "pending" } })
      const question = yield* Question.Service
      yield* say(session.id, "dev-cycle", "Write the plan.")
      yield* llm.tool("question", {
        questions: [
          {
            header: "Gate 2",
            question: "Approve the plan?",
            options: [
              { label: "Approve", description: "Start building" },
              { label: "Revise", description: "Change the plan" },
            ],
          },
        ],
      })
      yield* llm.text("Plan approved. Next I'll implement step 1.")
      yield* llm.tool("glob", { pattern: "**/*" })
      yield* llm.text("Step 1 is built.")

      const loop = yield* run(session.id).pipe(Effect.forkScoped)
      const pending = yield* waitForQuestion
      yield* question.reply({ requestID: pending.id, answers: [["Approve"]] })
      yield* Fiber.join(loop)

      expect(continuations(yield* history(session.id))).toHaveLength(1)
      expect(yield* modelCalls()).toHaveLength(4)
    }),
  )

  it.instance("at a pending gate with a question waiting, it waits for the human", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "plan", gate: "pending" } })
      const question = yield* Question.Service
      yield* say(session.id, "dev-cycle", "Write the plan.")
      yield* llm.tool("question", {
        questions: [
          { header: "Gate 2", question: "Approve the plan?", options: [{ label: "Approve", description: "Go" }] },
        ],
      })

      const loop = yield* run(session.id).pipe(Effect.forkScoped)
      const pending = yield* waitForQuestion
      yield* Effect.sleep("200 millis")
      // Nothing else is sent while the question waits.
      expect(yield* modelCalls()).toHaveLength(1)
      yield* question.reject(pending.id)
      yield* Fiber.join(loop)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )

  it.instance("with the gate pending and no approval, a stall-looking message doesn't pass the gate", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "plan", gate: "pending" } })
      yield* say(session.id, "dev-cycle", "Write the plan.")
      yield* llm.text("The plan is written. Next I'll implement step 1.")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )

  it.instance("a turn that ends with a real question to the user doesn't continue", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "build", gate: "approved" } })
      yield* say(session.id, "dev-cycle", "Approved.")
      yield* llm.text("I'll need a database for this. Should I use PostgreSQL or SQLite?")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )

  it.instance("a finished cycle (gate 3 approved) doesn't continue", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "verify", gate: "approved" } })
      yield* say(session.id, "dev-cycle", "Approved.")
      yield* llm.text("Cycle complete. Next I'll hand over the summary.")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )

  it.instance("three continuations without progress stop with the message and its buttons", () =>
    Effect.gen(function* () {
      const { session, llm, file } = yield* setup({
        agent: "dev-cycle",
        cursor: { phase: "build", gate: "approved" },
      })
      const question = yield* Question.Service
      yield* say(session.id, "dev-cycle", "Approved.")
      for (let i = 0; i < 4; i++) yield* llm.text("Next I'll implement step 1.")

      const loop = yield* run(session.id).pipe(Effect.forkScoped)
      const pending = yield* waitForQuestion
      expect(pending.questions[0].question).toBe("Dev-Cycle stopped making progress after 3 retries.")
      expect(pending.questions[0].options.map((option) => option.label)).toEqual(["Continue", "Open cycle file"])
      expect(pending.questions[0].options[1].description).toContain(file)
      yield* question.reply({ requestID: pending.id, answers: [["Open cycle file"]] })
      yield* Fiber.join(loop)

      const sent = continuations(yield* history(session.id))
      expect(sent.map((msg) => label(msg)?.attempt)).toEqual([1, 2, 3])
      expect(yield* modelCalls()).toHaveLength(4)
    }),
  )

  it.instance("Continue after giving up tries again, and isn't taken as an approval", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "dev-cycle", cursor: { phase: "build", gate: "approved" } })
      const question = yield* Question.Service
      yield* say(session.id, "dev-cycle", "Approved.")
      for (let i = 0; i < 4; i++) yield* llm.text("Next I'll implement step 1.")
      yield* llm.tool("glob", { pattern: "**/*" })
      yield* llm.text("Step 1 is built.")

      const loop = yield* run(session.id).pipe(Effect.forkScoped)
      const pending = yield* waitForQuestion
      yield* question.reply({ requestID: pending.id, answers: [["Continue"]] })
      yield* Fiber.join(loop)

      const msgs = yield* history(session.id)
      const resume = userMessages(msgs).at(-1)!
      expect(resume.parts.some((part) => part.type === "text" && part.metadata?.[AutoContinue.RESUME])).toBe(true)
      expect(AutoContinue.approved([resume])).toBe(false)
      expect(yield* modelCalls()).toHaveLength(6)
    }),
  )

  it.instance("dev_cycle.auto_continue: false restores waiting for the user", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({
        agent: "dev-cycle",
        cursor: { phase: "build", gate: "approved" },
        config: { dev_cycle: { auto_continue: false } },
      })
      yield* say(session.id, "dev-cycle", "Approved.")
      yield* llm.text("Plan approved. Next I'll implement step 1.")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )

  it.instance("an organisation's locked dev_cycle.auto_continue: false holds over project config", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(
        path.join(managedDir, "opencode.json"),
        JSON.stringify({ $locked: ["dev_cycle.auto_continue"], dev_cycle: { auto_continue: false } }),
      )
      yield* Effect.addFinalizer(() => fs.remove(path.join(managedDir, "opencode.json")).pipe(Effect.ignore))
      const { session, llm } = yield* setup({
        agent: "dev-cycle",
        cursor: { phase: "build", gate: "approved" },
        config: { dev_cycle: { auto_continue: true } },
      })
      yield* say(session.id, "dev-cycle", "Approved.")
      yield* llm.text("Plan approved. Next I'll implement step 1.")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )
})

describe("Build and Plan (XCOD-302)", () => {
  it.instance('a Build turn that ends with "Next I\'ll…" continues', () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "build" })
      yield* say(session.id, "build", "Add a health endpoint.")
      yield* llm.text("Next I'll add the /health route and run the tests.")
      yield* llm.tool("glob", { pattern: "**/*" })
      yield* llm.text("Added GET /health; the tests pass.")

      yield* run(session.id)

      const sent = continuations(yield* history(session.id))
      expect(sent).toHaveLength(1)
      expect(label(sent[0])?.label).toBe("Build continued automatically")
      const calls = yield* modelCalls()
      expect(calls).toHaveLength(3)
      expect(JSON.stringify(calls[1])).toContain("Continue the task now")
    }),
  )

  it.instance("a finished Build turn doesn't continue", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "build" })
      yield* say(session.id, "build", "Add a health endpoint.")
      yield* llm.text("Added GET /health. Build, tests and a request to it all pass.\n\nNext steps: deploy to staging.")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )

  it.instance("agent.build.auto_continue: false turns it off for Build", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "build", config: { agent: { build: { auto_continue: false } } } })
      yield* say(session.id, "build", "Add a health endpoint.")
      yield* llm.text("Next I'll add the /health route.")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )

  it.instance("Plan never continues", () =>
    Effect.gen(function* () {
      const { session, llm } = yield* setup({ agent: "plan" })
      yield* say(session.id, "plan", "Plan a health endpoint.")
      yield* llm.text("Next I'll write the plan file.")

      yield* run(session.id)

      expect(continuations(yield* history(session.id))).toHaveLength(0)
      expect(yield* modelCalls()).toHaveLength(1)
    }),
  )
})
