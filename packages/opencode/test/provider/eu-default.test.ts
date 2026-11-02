import { afterAll, afterEach, expect, mock } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

// XCOD-320: a fresh install with an EU-only policy takes its default and Recommended from the
// published eval results. The shipped results file is swapped for a fixture here.
const SHIPPED = path.join(import.meta.dir, "../../src/provider/eval-results.json")
const original = JSON.parse(readFileSync(SHIPPED, "utf8"))
const fixture = (file: string) => JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", file), "utf8"))
const results = (data: unknown) =>
  Effect.promise(() => Promise.resolve(mock.module(SHIPPED, () => ({ default: data }))))

const envKeys = ["SCALEWAY_API_KEY", "OPENAI_API_KEY"]
const saved = new Map(envKeys.map((key) => [key, process.env[key]]))
const keys = Effect.sync(() => {
  for (const key of envKeys) process.env[key] = "test-api-key"
})

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await disposeAllInstances()
})
afterAll(() => mock.module(SHIPPED, () => ({ default: original })))

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
const eu = { config: { residency: { allow: ["eu" as const] } } }

it.instance(
  "a fresh EU-only install defaults to the best EU model that passed at least half the tasks",
  Effect.gen(function* () {
    yield* results(fixture("eval-results-eu.json"))
    yield* keys
    const model = yield* Provider.use.defaultModel()
    // Not the higher-scoring US model, which the policy refuses anyway.
    expect(`${model.providerID}/${model.modelID}`).toBe("scaleway/qwen3-coder-30b-a3b-instruct")
    const providers = yield* Provider.use.list()
    const recommended = Object.values(providers).flatMap((provider) =>
      Object.values(provider.models).flatMap((item) =>
        item.recommended ? [`${provider.id}/${item.id}: ${item.recommended}`] : [],
      ),
    )
    expect(recommended).toEqual(["scaleway/qwen3-coder-30b-a3b-instruct: Best EU eval: passed 60% of 33 tasks"])
  }),
  eu,
)

it.instance(
  "with no EU model at 50%, an EU-only install recommends nothing",
  Effect.gen(function* () {
    yield* results(fixture("eval-results-eu-none.json"))
    yield* keys
    const providers = yield* Provider.use.list()
    expect(Object.keys(providers)).toContain(ProviderV2.ID.make("scaleway"))
    for (const provider of Object.values(providers))
      for (const model of Object.values(provider.models)) expect(model.recommended).toBeUndefined()
    const model = yield* Provider.use.defaultModel()
    expect(String(model.providerID)).not.toBe("openai")
  }),
  eu,
)

it.instance(
  "without a residency policy the curated list stays",
  Effect.gen(function* () {
    yield* results(fixture("eval-results-eu.json"))
    yield* keys
    const providers = yield* Provider.use.list()
    expect(providers[ProviderV2.ID.make("scaleway")].models["qwen3-coder-30b-a3b-instruct"].recommended).toBe(
      "EU-hosted (Scaleway, France); open-weight coder",
    )
  }),
)
