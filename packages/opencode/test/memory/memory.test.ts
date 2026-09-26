import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Global } from "@opencode-ai/core/global"
import { Effect, Schema } from "effect"
import { Memory } from "../../src/memory"
import { MemoryModel } from "../../src/memory/model"
import { MemorySidecar } from "../../src/memory/sidecar"
import { MemoryStore } from "../../src/memory/store"
import { MemorySwitch } from "../../src/memory/switch"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Memory.node, CrossSpawnSpawner.node])))
const parent = { providerID: "openai", modelID: "gpt-5.5" }

afterEach(async () => {
  delete process.env[MemorySwitch.ENV]
  await disposeAllInstances()
})

async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

/** "Off" must mean off: nothing on disk, and the sidecar was never installed, so never started. */
async function expectNothingStarted(dir: string) {
  expect(await exists(path.join(dir, ".opencode", "memory"))).toBe(false)
  expect(await exists(MemoryStore.dir("user", dir))).toBe(false)
  expect(await exists(MemoryStore.sidecarDir())).toBe(false)
}

describe("MemorySwitch.decide", () => {
  test("off when memory isn't configured", () => {
    expect(MemorySwitch.decide({ config: undefined, env: {} })).toMatchObject({ on: false, by: "config" })
    expect(MemorySwitch.decide({ config: { enabled: false }, env: {} })).toMatchObject({ on: false, by: "config" })
  })

  test("on only when memory.enabled is true", () => {
    expect(MemorySwitch.decide({ config: { enabled: true }, env: {} })).toEqual({ on: true })
  })

  test("LUNOS_DISABLE_MEMORY beats config, and '0' / 'false' / '' don't count", () => {
    const config = { enabled: true }
    expect(MemorySwitch.decide({ config, env: { LUNOS_DISABLE_MEMORY: "1" } })).toMatchObject({ on: false, by: "env" })
    expect(MemorySwitch.decide({ config, env: { LUNOS_DISABLE_MEMORY: "yes" } })).toMatchObject({ by: "env" })
    for (const value of ["0", "false", ""])
      expect(MemorySwitch.decide({ config, env: { LUNOS_DISABLE_MEMORY: value } })).toEqual({ on: true })
  })

  test("/memory off beats config for that session", () => {
    expect(MemorySwitch.decide({ config: { enabled: true }, env: {}, sessionOff: true })).toMatchObject({
      on: false,
      by: "session",
    })
  })
})

describe("MemoryModel", () => {
  test('defaults to "small", falling back to the main model', () => {
    expect(MemoryModel.resolve({ memory: {}, small_model: "mistral/mistral-small-latest", parent })).toEqual({
      model: { providerID: "mistral", modelID: "mistral-small-latest" },
      source: "memory.model (default: small)",
    })
    expect(MemoryModel.resolve({ memory: {}, small_model: undefined, parent }).model).toEqual(parent)
  })

  test('"inherit" and "provider/model"', () => {
    expect(MemoryModel.resolve({ memory: { model: "inherit" }, small_model: "a/b", parent }).model).toEqual(parent)
    expect(
      MemoryModel.resolve({ memory: { model: "scaleway/llama-3.3-70b" }, small_model: undefined, parent }),
    ).toEqual({ model: { providerID: "scaleway", modelID: "llama-3.3-70b" }, source: "memory.model" })
    expect(() => MemoryModel.resolve({ memory: { model: "gpt" }, small_model: undefined, parent })).toThrow(
      /provider\/model/,
    )
  })

  test("only local embeddings are accepted", () => {
    expect(() => MemoryModel.checkEmbedding(undefined)).not.toThrow()
    expect(() => MemoryModel.checkEmbedding({ embedding: "openai/text-embedding-3-small" })).toThrow(/not supported/)
  })
})

describe("MemorySidecar.environment", () => {
  test("passes an allow-list, never provider keys or tokens", () => {
    const env = MemorySidecar.environment({
      root: "/m",
      env: { PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk-x", GITHUB_TOKEN: "t", MISTRAL_API_KEY: "m" },
    })
    expect(env.PATH).toBe("/bin")
    expect(env.LUNOS_MEMORY_DIR).toBe("/m")
    expect(env.UV_PYTHON_DOWNLOADS).toBe("never")
    expect(env.TELEMETRY_DISABLED).toBe("1")
    expect(Object.keys(env).some((key) => /KEY|TOKEN/.test(key))).toBe(false)
  })
})

describe("config", () => {
  test("memory decodes through the live ConfigV1.Info path", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({
      memory: {
        enabled: true,
        scope: ["project", "user"],
        model: "small",
        embedding: "local",
        retrieval: { max_tokens: 1500 },
        limits: { max_facts: 5000, max_fact_chars: 2000 },
      },
    })
    expect(decoded.memory?.enabled).toBe(true)
    expect(decoded.memory?.scope).toEqual(["project", "user"])
  })
})

describe("Memory service: off means off", () => {
  it.live("with no memory config, nothing starts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(yield* memory.decision()).toMatchObject({ on: false, by: "config" })
        const error = yield* memory.backend({ scope: "project", parent }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Memory.OffError)
        yield* Effect.promise(() => expectNothingStarted(dir))
      }),
    ),
  )

  it.live("memory.enabled plus LUNOS_DISABLE_MEMORY=1: nothing starts", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          process.env[MemorySwitch.ENV] = "1"
          const memory = yield* Memory.Service
          const error = yield* memory.backend({ scope: "project", parent }).pipe(Effect.flip)
          expect(error.message).toContain("LUNOS_DISABLE_MEMORY")
          yield* Effect.promise(() => expectNothingStarted(dir))
        }),
      { config: { memory: { enabled: true, scope: ["project", "user"] } } },
    ),
  )

  it.live("/memory off stops memory for that session only", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const memory = yield* Memory.Service
          yield* memory.setSessionOff("ses_a", true)
          expect(yield* memory.decision("ses_a")).toMatchObject({ on: false, by: "session" })
          expect(yield* memory.decision("ses_b")).toEqual({ on: true })
          const error = yield* memory.backend({ scope: "project", sessionID: "ses_a", parent }).pipe(Effect.flip)
          expect(error).toBeInstanceOf(Memory.OffError)
          yield* Effect.promise(() => expectNothingStarted(dir))
        }),
      { config: { memory: { enabled: true } } },
    ),
  )

  it.live("a residency policy that denies memory.model stops memory before it starts", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const memory = yield* Memory.Service
          const error = yield* memory.backend({ scope: "project", parent }).pipe(Effect.flip)
          expect(error.message).toContain("memory.model → openai/gpt-4o denied by residency policy")
          yield* Effect.promise(() => expectNothingStarted(dir))
          // The audit write is asynchronous (Residency's append doesn't wait for it).
          const denied = yield* Effect.promise(async () => {
            for (let i = 0; i < 40; i++) {
              const log = await fs.readFile(path.join(Global.Path.log, "residency-egress.log"), "utf8").catch(() => "")
              const lines = log
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .filter((line) => line.providerID === "openai" && line.allowed === false)
              if (lines.length) return lines
              await Bun.sleep(50)
            }
            return []
          })
          expect(denied.length).toBeGreaterThan(0)
        }),
      { config: { memory: { enabled: true, model: "openai/gpt-4o" }, residency: { allow: ["eu"] } } },
    ),
  )
})
