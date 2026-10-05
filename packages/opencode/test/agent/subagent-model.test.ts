import { describe, expect, test } from "bun:test"
import { SubagentModel } from "../../src/agent/subagent-model"
import { withModelParameter } from "../../src/tool/task"

const parent = { providerID: "mistral", modelID: "mistral-large-latest", variant: "high" }
const base = { subagentType: "explore", parent, config: {} }

describe("SubagentModel.resolve (XCOD-82)", () => {
  test("no config: inherits the main agent's model and reasoning variant", () => {
    expect(SubagentModel.resolve(base)).toEqual({
      model: { providerID: "mistral", modelID: "mistral-large-latest" },
      variant: "high",
      rule: "inherit",
      source: "inherit",
    })
  })

  test('agent.explore.model: "small" runs on small_model; others still inherit', () => {
    const config = { small_model: "mistral/mistral-small-latest" }
    const explore = SubagentModel.resolve({ ...base, config, typeModel: "small" })
    expect(explore).toMatchObject({
      model: { modelID: "mistral-small-latest" },
      rule: "per-type",
      source: "agent.explore.model",
    })
    expect(explore.variant).toBeUndefined()
    expect(SubagentModel.resolve({ ...base, subagentType: "general", config }).rule).toBe("inherit")
  })

  test('"small" without small_model falls back to inherit, keeping the variant', () => {
    const out = SubagentModel.resolve({ ...base, typeModel: "small" })
    expect(out.model).toEqual({ providerID: "mistral", modelID: "mistral-large-latest" })
    expect(out.variant).toBe("high")
  })

  test("subagent.model applies to every type without its own override", () => {
    const config = { subagent: { model: "scaleway/llama-3.3-70b-instruct" } }
    expect(SubagentModel.resolve({ ...base, config })).toMatchObject({ rule: "global", source: "subagent.model" })
    expect(SubagentModel.resolve({ ...base, config, typeModel: "mistral/codestral-latest" }).rule).toBe("per-type")
  })

  test("an overridden model uses the configured variant; inherit keeps the parent's", () => {
    expect(SubagentModel.resolve({ ...base, typeModel: "mistral/codestral-latest", typeVariant: "low" }).variant).toBe(
      "low",
    )
    expect(SubagentModel.resolve({ ...base, typeModel: "inherit", typeVariant: "max" }).variant).toBe("max")
  })

  test("dynamic: an allowed per-call model wins; anything else is refused, never replaced", () => {
    const config = { subagent: { dynamic: { enabled: true, allow: ["mistral/codestral-latest"] } } }
    expect(SubagentModel.resolve({ ...base, config, perCall: "mistral/codestral-latest" }).rule).toBe("per-call")
    expect(() => SubagentModel.resolve({ ...base, config, perCall: "openai/gpt-x" })).toThrow(
      /not on subagent.dynamic.allow/,
    )
    expect(() => SubagentModel.resolve({ ...base, perCall: "mistral/codestral-latest" })).toThrow(/disabled/)
  })

  test("residency: a denied model is refused with the rule that chose it", () => {
    const out = SubagentModel.resolve({ ...base, subagentType: "qa", typeModel: "anthropic/claude-haiku-4-5" })
    expect(() =>
      SubagentModel.checkResidency(out, { policy: { allow: ["eu"] }, audit: false, auditPath: undefined }),
    ).toThrow(/agent\.qa\.model → anthropic\/claude-haiku-4-5 denied by residency policy/)
    expect(() =>
      SubagentModel.checkResidency(SubagentModel.resolve(base), {
        policy: { allow: ["eu"] },
        audit: false,
        auditPath: undefined,
      }),
    ).not.toThrow()
  })

  test("the dynamic allow list offered to the model excludes residency-denied entries", () => {
    const config = { subagent: { dynamic: { enabled: true, allow: ["mistral/codestral-latest", "openai/gpt-x"] } } }
    expect(SubagentModel.allowed(config, { policy: { allow: ["eu"] }, audit: false, auditPath: undefined })).toEqual([
      "mistral/codestral-latest",
    ])
    expect(SubagentModel.allowed({})).toEqual([])
  })
})

describe("task tool model parameter", () => {
  const schema = {
    type: "object" as const,
    properties: { prompt: { type: "string" as const }, model: { type: "string" as const } },
  }
  test("absent unless models are allowed, and then an enum of exactly those", () => {
    expect(withModelParameter(schema, []).properties).not.toHaveProperty("model")
    expect(withModelParameter(schema, ["a/b"]).properties?.model).toMatchObject({ enum: ["a/b"] })
  })
})
