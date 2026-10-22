import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
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
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
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
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

import { Resource } from "@/resource"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

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

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
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
])

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://lunos.tech/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

// XCOD-300: project resources on the live v1 session path, against a fake model: an Always resource
// is in the system prompt of a session in the project, and the agent can call
// project_resources_search, whose results cite their source and are labelled as reference material.

const it = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode, Resource.node]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
  ]),
)

const ALWAYS = "Deploys go out on Tuesdays only, after the release review."
const SEARCHED = "The payments webhook retries five times with exponential backoff, then parks the event."

it.instance(
  "an Always resource is in the system prompt and Search resources are reachable through the tool",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeText(path.join(dir, "docs", "deploy.md"), ALWAYS)
      yield* writeText(path.join(dir, "specs", "payments.md"), `# Payments\n\n${SEARCHED}\n`)
      yield* writeText(path.join(dir, "specs", ".env"), "STRIPE_SECRET=sk_live_should_never_appear")
      yield* writeConfig(dir, {
        ...providerCfg(llm.url),
        resources: {
          entries: {
            deploy: { path: "docs/deploy.md", mode: "always", description: "How we deploy" },
            payments: { path: "specs", description: "Payments API spec" },
            design: { path: "docs", mode: "on_demand" },
          },
        },
      } as Partial<ConfigV1.Info>)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Resources",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(chat.id, "How do webhook retries work?")
      yield* llm.tool("project_resources_search", { query: "webhook retries backoff" })
      yield* llm.text("From Payments API spec, payments.md: five retries.")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const hits = yield* llm.hits
      const first = JSON.stringify(hits[0]?.body)
      // Always: in full, wrapped as reference material, in the system prompt.
      expect(first).toContain(ALWAYS)
      expect(first).toContain('<project-resource name=\\"deploy\\"')
      expect(first).toContain("Reference material from the project resource")
      // Search: listed with its description, and offered as a tool; on_demand: listed, not included.
      expect(first).toContain("payments (path): Payments API spec")
      expect(first).toContain("project_resources_search")
      expect(first).not.toContain(SEARCHED)
      expect(first).toContain("design (path)")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const call = msgs
        .flatMap((msg) => msg.parts)
        .find((part) => part.type === "tool" && part.tool === "project_resources_search")
      expect(call?.type === "tool" && call.state.status).toBe("completed")
      const output = call?.type === "tool" && call.state.status === "completed" ? call.state.output : ""
      expect(output).toContain(SEARCHED)
      expect(output).toContain('<project-resource name="payments" source="payments.md" trust="project">')
      expect(output).not.toContain("sk_live_should_never_appear")
      // The tool result reached the model on the next step.
      expect(JSON.stringify(hits[1]?.body)).toContain(SEARCHED)

      // /context's breakdown for this turn.
      const resources = yield* Resource.Service
      const turn = yield* resources.turn(chat.id)
      expect(turn?.always).toBeGreaterThan(0)
      expect(turn?.resources.map((item) => item.name)).toEqual(["deploy"])
      expect(turn?.searched).toBeGreaterThan(0)
    }),
  30_000,
)

it.instance(
  "@name pulls an on-demand resource into the turn, and an excluded resource leaves the context",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeText(path.join(dir, "notes", "glossary.md"), "A widget is a unit of billing.")
      yield* writeText(path.join(dir, "docs", "deploy.md"), ALWAYS)
      yield* writeConfig(dir, {
        ...providerCfg(llm.url),
        resources: {
          entries: {
            glossary: { path: "notes", mode: "on_demand" },
            deploy: { path: "docs/deploy.md", mode: "always" },
          },
        },
      } as Partial<ConfigV1.Info>)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const resources = yield* Resource.Service
      const chat = yield* sessions.create({
        title: "Mention",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* resources.exclude(chat.id, "deploy", true)
      yield* user(chat.id, "What is a widget? See @glossary.")
      yield* llm.text("A unit of billing, from glossary.")
      yield* prompt.loop({ sessionID: chat.id })
      const body = JSON.stringify((yield* llm.hits)[0]?.body)
      expect(body).toContain("A widget is a unit of billing.")
      expect(body).not.toContain(ALWAYS)
      // No searchable resources, so no search tool.
      expect(body).not.toContain('project_resources_search\\"')
    }),
  30_000,
)
