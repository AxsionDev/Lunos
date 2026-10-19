import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Residency } from "@opencode-ai/core/residency"
import { MemoryFailure } from "../../src/memory/failure"
import { MemorySidecar } from "../../src/memory/sidecar"
import { MemoryStore } from "../../src/memory/store"
import { tmpdir } from "../fixture/fixture"

// XCOD-263: the real Cognee sidecar, with failures injected through the fake sampling handler or
// the environment. No model is ever called. Opt-in like sidecar-e2e.test.ts:
// LUNOS_MEMORY_E2E=1 LUNOS_MEMORY_E2E_CACHE=<dir> bun test test/memory/sidecar-failure-e2e.test.ts
const run = process.env.LUNOS_MEMORY_E2E === "1" && Bun.which("uv") ? test : test.skip
const cache = process.env.LUNOS_MEMORY_E2E_CACHE
const MODEL = { providerID: "fake", modelID: "memory-model" }

/** Answers Cognee's sampling requests like a model that does its job (see sidecar-e2e.test.ts). */
const good: MemorySidecar.Sample = async (input) => {
  const schema = JSON.parse(input.system?.match(/JSON Schema:\n(\{.*\})/s)?.[1] ?? "{}")
  if (schema.title === "KnowledgeGraph") return JSON.stringify({ nodes: [], edges: [] })
  if (schema.title === "SummarizedContent") return JSON.stringify({ summary: "a fact", description: "" })
  return "{}"
}

async function remember(input: {
  sample: MemorySidecar.Sample
  callTimeout?: number
  env?: Record<string, string>
  models?: string
  prepare?: (root: string) => Promise<void>
}) {
  await using tmp = await tmpdir()
  const root = await MemoryStore.ensure("project", tmp.path)
  await input.prepare?.(root)
  const handle = await MemorySidecar.start({
    root,
    sample: input.sample,
    model: MODEL,
    callTimeout: input.callTimeout,
    env: { ...process.env, ...(cache ? { UV_CACHE_DIR: path.join(cache, "uv") } : {}), ...input.env },
    models: input.models ?? (cache ? path.join(cache, "models") : undefined),
  })
  try {
    await handle.call("remember", { text: "The billing service owns the invoices table.", dataset: "main" })
    throw new Error("remember succeeded")
  } catch (error) {
    if (!(error instanceof MemoryFailure.EngineError)) throw error
    const log = error.info.log
    console.log(JSON.stringify({ message: error.message, info: error.info, fix: MemoryFailure.fix(error.info) }))
    expect(error.message).not.toMatch(/failed:\s*$/)
    expect(error.message).not.toContain("The billing service owns")
    expect(log).toBeTruthy()
    expect((await fs.readdir(path.join(root, "logs"))).some((name) => MemorySidecar.STDERR_LOG.test(name))).toBe(true)
    return error.info
  } finally {
    await handle.close()
  }
}

describe("memory sidecar failures, end to end", () => {
  run(
    "an exception with an empty message",
    async () => {
      const info = await remember({
        sample: async () => {
          throw new Error("")
        },
      })
      expect(info.stage).toBe("extraction")
      expect(MemoryFailure.reason(info).trim()).not.toBe("")
    },
    10 * 60_000,
  )

  run(
    "a provider 429",
    async () => {
      const info = await remember({
        sample: async () => {
          throw Object.assign(new Error("rate limited"), { statusCode: 429 })
        },
      })
      expect(info.stage).toBe("extraction")
      expect(info.sampling[0]).toEqual({ provider: "fake", model: "memory-model", message: "429 rate limited" })
      expect(MemoryFailure.fix(info)?.kind).toBe("rate-limit")
    },
    10 * 60_000,
  )

  run(
    "a residency refusal",
    async () => {
      const info = await remember({
        sample: async () => {
          throw new Residency.DeniedError({ reason: "fake is not in the allowed jurisdictions (EU)" } as never)
        },
      })
      expect(info.stage).toBe("extraction")
      expect(MemoryFailure.fix(info)?.kind).toBe("model-residency")
    },
    10 * 60_000,
  )

  run(
    "a model returning invalid JSON",
    async () => {
      const info = await remember({ sample: async () => "Sure! Here are the entities: billing, invoices." })
      expect(info.stage).toBe("extraction")
      expect(MemoryFailure.fix(info)?.kind).toBe("structured-output")
    },
    10 * 60_000,
  )

  run(
    "a timeout during extraction",
    async () => {
      const info = await remember({ sample: () => new Promise(() => {}), callTimeout: 30_000 })
      expect(info.stage).toBe("extraction")
      expect(MemoryFailure.fix(info)?.kind).toBe("timeout")
    },
    10 * 60_000,
  )

  run(
    "a read-only memory directory",
    async () => {
      const info = await remember({
        sample: good,
        prepare: async (root) => {
          for (const dir of ["data", "system", "cache"]) {
            await fs.mkdir(path.join(root, dir), { recursive: true })
            await fs.chmod(path.join(root, dir), 0o555)
          }
        },
      })
      expect(MemoryFailure.fix(info)?.kind).toBe("storage")
    },
    10 * 60_000,
  )

  run(
    "an embedding model download failure",
    async () => {
      await using models = await tmpdir()
      const info = await remember({
        sample: good,
        models: models.path,
        env: { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
      })
      expect(info.stage).toBe("embedding")
      expect(MemoryFailure.fix(info)?.kind).toBe("embedding-download")
    },
    10 * 60_000,
  )
})
