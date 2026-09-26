export * as MemorySidecar from "./sidecar"

import fs from "node:fs/promises"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import SCRIPT from "./sidecar.py" with { type: "text" }
import LOCK from "./sidecar.py.lock" with { type: "text" }
import { MemoryStore } from "./store"

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
 */

export class UnavailableError extends Error {
  override name = "MemoryUnavailable"
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
  call<T>(tool: "remember" | "recall" | "forget", args: Record<string, unknown>): Promise<T>
  close(): Promise<void>
}

export async function start(input: {
  root: string
  sample: Sample
  env?: Record<string, string | undefined>
  /** Where the embedding model is kept. Defaults to the shared models directory. */
  models?: string
}): Promise<Handle> {
  const uv = Bun.which("uv")
  if (!uv)
    throw new UnavailableError(
      "Memory needs uv (https://docs.astral.sh/uv/) and Python 3.10–3.13. Install uv, or turn memory off.",
    )
  const script = await install()
  const stderr: string[] = []
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
  })
  const client = new Client({ name: "lunos-memory", version: InstallationVersion }, { capabilities: { sampling: {} } })
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
    const text = request.params.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : [message.content]))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n\n")
    const reply = await input.sample({
      system: request.params.systemPrompt,
      text,
      maxTokens: request.params.maxTokens,
    })
    return { role: "assistant", content: { type: "text", text: reply }, model: "lunos", stopReason: "endTurn" }
  })
  try {
    await client.connect(transport, { timeout: START_TIMEOUT })
  } catch (error) {
    await transport.close().catch(() => {})
    const tail = stderr.join("").trim().split("\n").slice(-5).join("\n")
    throw new UnavailableError(
      `Memory could not start: ${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ""}`,
    )
  }
  return {
    async call<T>(tool: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT,
        resetTimeoutOnProgress: true,
      })
      const text = (result.content as { type: string; text?: string }[])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
      if (result.isError) throw new Error(`Memory ${tool} failed: ${text}`)
      return (result.structuredContent ?? JSON.parse(text)) as T
    },
    async close() {
      await client.close().catch(() => {})
    },
  }
}
