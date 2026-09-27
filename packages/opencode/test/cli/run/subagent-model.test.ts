// XCOD-82: subagent model selection in a real `lunos run`. The scripted LLM records every request
// body, so each test asserts the model the subagent *actually called*, not just what the resolver
// returned, plus the rule recorded in the task tool's metadata.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { reply } from "../../lib/llm-server"
import { cliIt, type CliFixture } from "../../lib/cli-process"

const smallModel = {
  id: "small-model",
  name: "Small Model",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 0, output: 0 },
  options: {},
}

// Merged with the harness's inline provider config: adds test/small-model, plus whatever the case needs.
async function configure(home: string, extra: Record<string, unknown>) {
  const dir = path.join(home, ".config", "opencode")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({ provider: { test: { models: { "small-model": smallModel } } }, ...extra }),
  )
}

function runTask(fixture: CliFixture, task: Record<string, unknown>) {
  return Effect.gen(function* () {
    yield* fixture.llm.push(
      reply().tool("task", { description: "look", prompt: "look around", subagent_type: "explore", ...task }),
    )
    yield* fixture.llm.text("subagent answer")
    yield* fixture.llm.text("main done")
    const result = yield* fixture.opencode.run("delegate", { permission: { "*": "allow" }, format: "json" })
    fixture.opencode.expectExit(result, 0)
    const part = fixture.opencode
      .parseJsonEvents(result.stdout)
      .map((event) => (event as { part?: { tool?: string; state?: Record<string, any> } }).part)
      .find((item) => item?.tool === "task")
    // Session title generation also calls the LLM (on small_model); only the agent turns matter here.
    const models = (yield* fixture.llm.inputs)
      .filter((input: any) => !JSON.stringify(input.messages?.[0]?.content ?? "").includes("title generator"))
      .map((input) => input.model)
    return { state: part?.state, models }
  })
}

describe("subagent model selection in a real run", () => {
  cliIt.live(
    "no subagent config: the subagent runs on the main agent's model",
    (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => configure(fixture.home, {}))
        const { state, models } = yield* runTask(fixture, {})
        expect(state?.metadata).toMatchObject({ model: { modelID: "test-model" }, modelRule: "inherit" })
        expect(models).toEqual(["test-model", "test-model", "test-model"])
      }),
    90_000,
  )

  cliIt.live(
    'agent.explore.model: "small" runs explore on small_model',
    (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          configure(fixture.home, { small_model: "test/small-model", agent: { explore: { model: "small" } } }),
        )
        const { state, models } = yield* runTask(fixture, {})
        expect(state?.metadata).toMatchObject({
          model: { modelID: "small-model" },
          modelRule: "per-type",
          modelSource: "agent.explore.model",
        })
        expect(models).toEqual(["test-model", "small-model", "test-model"])
      }),
    90_000,
  )

  cliIt.live(
    "subagent.model applies to a type without its own override",
    (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => configure(fixture.home, { subagent: { model: "test/small-model" } }))
        const { state, models } = yield* runTask(fixture, {})
        expect(state?.metadata).toMatchObject({ model: { modelID: "small-model" }, modelRule: "global" })
        expect(models[1]).toBe("small-model")
      }),
    90_000,
  )

  cliIt.live(
    "dynamic: an allowed per-call model is used; one off the list is refused with a tool error",
    (fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          configure(fixture.home, { subagent: { dynamic: { enabled: true, allow: ["test/small-model"] } } }),
        )
        const allowed = yield* runTask(fixture, { model: "test/small-model" })
        expect(allowed.state?.metadata).toMatchObject({ model: { modelID: "small-model" }, modelRule: "per-call" })
        expect(allowed.models[1]).toBe("small-model")

        yield* fixture.llm.reset
        yield* fixture.llm.push(
          reply().tool("task", {
            description: "look",
            prompt: "look",
            subagent_type: "explore",
            model: "test/test-model",
          }),
        )
        yield* fixture.llm.text("main done")
        const result = yield* fixture.opencode.run("delegate", { permission: { "*": "allow" }, format: "json" })
        const part = fixture.opencode
          .parseJsonEvents(result.stdout)
          .map((event) => (event as { part?: { tool?: string; state?: Record<string, any> } }).part)
          .find((item) => item?.tool === "task")
        expect(part?.state?.status).toBe("error")
        expect(part?.state?.error).toContain("not on subagent.dynamic.allow")
      }),
    120_000,
  )

  cliIt.live(
    "residency: a denied per-type model stops the subagent before it starts, names the rule, and is audited",
    (fixture) =>
      Effect.gen(function* () {
        const audit = path.join(fixture.home, "egress.log")
        yield* Effect.promise(() =>
          configure(fixture.home, {
            residency: { allow: ["eu"], auditPath: audit },
            // An EU-tagged provider id pointed at the scripted LLM, so the main agent is allowed.
            provider: {
              test: { models: { "small-model": smallModel } },
              mistral: {
                npm: "@ai-sdk/openai-compatible",
                models: { "eu-model": { ...smallModel, id: "eu-model", name: "EU Model" } },
                options: { apiKey: "test-key", baseURL: fixture.llm.url },
              },
            },
            agent: { explore: { model: "anthropic/claude-haiku-4-5" } },
          }),
        )
        yield* fixture.llm.push(reply().tool("task", { description: "look", prompt: "look", subagent_type: "explore" }))
        yield* fixture.llm.text("main done")
        const result = yield* fixture.opencode.run("delegate", {
          model: "mistral/eu-model",
          permission: { "*": "allow" },
          format: "json",
        })
        const part = fixture.opencode
          .parseJsonEvents(result.stdout)
          .map((event) => (event as { part?: { tool?: string; state?: Record<string, any> } }).part)
          .find((item) => item?.tool === "task")
        expect(part?.state?.status).toBe("error")
        expect(part?.state?.error).toContain(
          "agent.explore.model → anthropic/claude-haiku-4-5 denied by residency policy",
        )
        const models = (yield* fixture.llm.inputs).map((input) => input.model)
        expect(models).not.toContain("claude-haiku-4-5")
        const lines = (yield* Effect.promise(() => fs.readFile(audit, "utf8"))).trim().split("\n")
        expect(lines.map((line) => JSON.parse(line))).toContainEqual(
          expect.objectContaining({ providerID: "anthropic", allowed: false }),
        )
      }),
    90_000,
  )
})
