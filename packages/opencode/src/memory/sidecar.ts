export * as MemorySidecar from "./sidecar"

import fs from "node:fs/promises"
import { closeSync, openSync, writeSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import SCRIPT from "./sidecar.py" with { type: "text" }
import LOCK from "./sidecar.py.lock" with { type: "text" }
import { MemoryFailure } from "./failure"
import { MemoryStore } from "./store"
import { Offline } from "@opencode-ai/core/offline"

/**
 * The Cognee sidecar (XCOD-94): `sidecar.py`, run with `uv` from its hash-pinned lock file, spoken
 * to over a private MCP client that belongs to memory alone.
 *
 * - It is not registered with the MCP service, so its tools are never offered to the model. The
 *   only way in is through Lunos's memory tools, after their permission and taint checks.
 * - This client, and only this one, grants the `sampling` capability. The sidecar's LLM calls
 *   come back here and are answered by `sample`, which runs the model resolved from
 *   `memory.model` through Lunos's normal model path (residency hook included). Any model the
 *   sidecar asks for is ignored.
 * - The child gets an allow-listed environment, not Lunos's: no provider keys, no tokens.
 * - `uv` is a prerequisite, never bundled. Python itself is not downloaded either
 *   (`UV_PYTHON_DOWNLOADS=never`): a missing Python 3.10–3.13 is an error that says so.
 * - A failed call is a `MemoryFailure.EngineError` (XCOD-263): the sidecar's exception type, cause
 *   chain and stage, plus the sampling requests that failed while it ran. The sidecar's stderr is
 *   kept in `<root>/logs/sidecar-<time>.stderr.txt` (the last few starts), next to cognee's own logs.
 */

/**
 * The engine and embedding model the sidecar pins, read from `sidecar.py` itself so they can't drift.
 * Recorded in an export's manifest (XCOD-132): engine database files only restore into the same.
 */
export const ENGINE = {
  name: "cognee",
  version: SCRIPT.match(/"cognee==([^"]+)"/)?.[1] ?? "unknown",
  embedding: {
    model: SCRIPT.match(/"EMBEDDING_MODEL": "([^"]+)"/)?.[1] ?? "unknown",
    dimensions: Number(SCRIPT.match(/"EMBEDDING_DIMENSIONS": "(\d+)"/)?.[1] ?? 0),
  },
}

export class UnavailableError extends Error {
  override name = "MemoryUnavailable"
  constructor(
    message: string,
    /** The sidecar's stderr log, when it got far enough to write one. */
    readonly log?: string,
  ) {
    super(message)
  }
}

/** Not `.log`: cognee prunes old `*.log` files in the same folder, and keeps its own count. */
export const STDERR_LOG = /^sidecar-.*\.stderr\.txt$/
const STDERR_KEEP = 5

/** A new stderr log for this start, after removing all but the newest few. */
async function stderrLog(root: string) {
  const dir = path.join(root, "logs")
  await fs.mkdir(dir, { recursive: true })
  const old = (await fs.readdir(dir)).filter((name) => STDERR_LOG.test(name)).sort()
  for (const name of old.slice(0, Math.max(0, old.length - (STDERR_KEEP - 1))))
    await fs.rm(path.join(dir, name), { force: true })
  return path.join(dir, `sidecar-${new Date().toISOString().replace(/[:.]/g, "-")}.stderr.txt`)
}

export interface SampleInput {
  system: string | undefined
  text: string
  maxTokens: number
}

export type Sample = (input: SampleInput) => Promise<string>

/** First start installs ~180 locked packages and the embedding model, so allow minutes. */
const START_TIMEOUT = 10 * 60_000
const CALL_TIMEOUT = 5 * 60_000

/** Variables the sidecar may see. Everything else in Lunos's environment stays behind. */
const PASS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "UV_CACHE_DIR",
  "UV_OFFLINE",
  "XDG_CACHE_HOME",
  "SSL_CERT_FILE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
]

export function environment(input: {
  root: string
  env: Record<string, string | undefined>
  models?: string
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PASS) {
    const value = input.env[key]
    if (value !== undefined) out[key] = value
  }
  return {
    ...out,
    LUNOS_MEMORY_DIR: input.root,
    LUNOS_MEMORY_MODELS: input.models ?? MemoryStore.models(),
    UV_PYTHON_DOWNLOADS: "never",
    TELEMETRY_DISABLED: "1",
    PYTHONUNBUFFERED: "1",
    // Offline mode (XCOD-121): only what uv and Hugging Face have already cached.
    ...(Offline.enabled() ? { UV_OFFLINE: "1", HF_HUB_OFFLINE: "1" } : {}),
  }
}

async function install() {
  const dir = MemoryStore.sidecarDir()
  await fs.mkdir(dir, { recursive: true })
  const script = path.join(dir, "sidecar.py")
  for (const [file, content] of [
    [script, SCRIPT],
    [script + ".lock", LOCK],
  ] as const) {
    const current = await fs.readFile(file, "utf8").catch(() => undefined)
    if (current !== content) await fs.writeFile(file, content)
  }
  return script
}

export interface Handle {
  call<T>(tool: "remember" | "recall" | "forget" | "graph", args: Record<string, unknown>): Promise<T>
  close(): Promise<void>
}

export async function start(input: {
  root: string
  sample: Sample
  env?: Record<string, string | undefined>
  /** Where the embedding model is kept. Defaults to the shared models directory. */
  models?: string
  /** The model `sample` runs, named in a failed sampling request. */
  model?: { providerID: string; modelID: string }
  callTimeout?: number
}): Promise<Handle> {
  const uv = Bun.which("uv")
  if (!uv)
    throw new UnavailableError(
      "Memory needs uv (https://docs.astral.sh/uv/) and Python 3.10–3.13. Install uv, or turn memory off.",
    )
  const script = await install()
  const stderr: string[] = []
  // A memory directory Lunos can't write to is itself a failure the check reports; the log just goes.
  const log = await stderrLog(input.root).catch(() => undefined)
  let file = (() => {
    try {
      return log ? openSync(log, "w") : undefined
    } catch {
      return undefined
    }
  })()
  const kept = file !== undefined ? log : undefined
  const closeLog = () => {
    try {
      if (file !== undefined) closeSync(file)
    } catch {}
    file = undefined
  }
  const transport = new StdioClientTransport({
    command: uv,
    args: ["run", "--quiet", "--locked", "--script", script],
    cwd: input.root,
    env: environment({ root: input.root, env: input.env ?? process.env, models: input.models }),
    stderr: "pipe",
  })
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString())
    if (stderr.length > 200) stderr.shift()
    try {
      if (file !== undefined) writeSync(file, chunk)
    } catch {}
  })
  const label = input.model ?? { providerID: "unknown", modelID: "unknown" }
  // Every sampling request and every failed one, so a failed call can say what its model did.
  const sampling = { count: 0, failed: [] as (MemoryFailure.Sampling & { at: number })[] }
  const client = new Client({ name: "lunos-memory", version: InstallationVersion }, { capabilities: { sampling: {} } })
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const text = request.params.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : [message.content]))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n\n")
    sampling.count++
    const reply = await input
      .sample({ system: request.params.systemPrompt, text, maxTokens: request.params.maxTokens })
      .catch((error: unknown) => {
        sampling.failed.push({
          at: sampling.count,
          provider: label.providerID,
          model: label.modelID,
          message: MemoryFailure.summary(error),
        })
        if (sampling.failed.length > 20) sampling.failed.shift()
        throw error
      })
    return { role: "assistant", content: { type: "text", text: reply }, model: "lunos", stopReason: "endTurn" }
  })
  try {
    await client.connect(transport, { timeout: START_TIMEOUT })
  } catch (error) {
    await transport.close().catch(() => {})
    closeLog()
    const tail = stderr.join("").trim().split("\n").slice(-5).join("\n")
    throw new UnavailableError(
      `Memory could not start: ${MemoryFailure.summary(error)}${tail ? `\n${tail}` : ""}`,
      kept,
    )
  }
  return {
    async call<T>(tool: string, args: Record<string, unknown>) {
      // Calls can overlap, so a failure attaches every sampling failure since it started.
      const count = sampling.count
      const context = () => ({
        sampling: sampling.failed.filter((item) => item.at > count).map(({ at: _, ...item }) => item),
        sampled: sampling.count > count,
        log: kept,
        dir: input.root,
        model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
      })
      const result = await client
        .callTool({ name: tool, arguments: args }, undefined, {
          timeout: input.callTimeout ?? CALL_TIMEOUT,
          resetTimeoutOnProgress: true,
        })
        .catch((error: unknown) => {
          throw new MemoryFailure.EngineError(tool, MemoryFailure.fromThrown(tool, error, context()))
        })
      const failure = MemoryFailure.fromToolResult(tool, result, context())
      if (failure) throw new MemoryFailure.EngineError(tool, failure)
      const text = (result.content as { type: string; text?: string }[])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
      return (result.structuredContent ?? JSON.parse(text)) as T
    },
    async close() {
      await client.close().catch(() => {})
      closeLog()
    },
  }
}
