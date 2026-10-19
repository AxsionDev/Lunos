export * as MemorySourceMcp from "./mcp"

import path from "node:path"
import type { ConfigMemorySource } from "@opencode-ai/core/config/memory-source"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

/**
 * An MCP memory source (XCOD-135): one search tool on a server configured under `mcp`. Memory opens
 * its own connection, only after the residency check, and only ever calls the one configured tool.
 * A tool the server marks as not read-only, or whose name says it writes, is refused.
 */

/** How long a source's MCP server may take to start and list its tools. */
export const CONNECT_TIMEOUT_MS = 30_000

export interface Client {
  search(query: string, timeoutMs: number): Promise<string[]>
  close(): Promise<void>
}

const WRITES =
  /^(add|create|delete|remove|update|write|store|save|insert|put|set|upsert|forget|clear|import|ingest|remember|patch|drop|purge)(_|-|$)|_(add|create|delete|remove|update|write|store|save|insert|upsert|forget|clear|purge)$/i

/** Why a tool may not be used as a read-only source, if it may not. */
export function writeShaped(tool: string, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
  if (annotations?.readOnlyHint === false || annotations?.destructiveHint === true)
    return `the server marks tool "${tool}" as one that changes data`
  if (WRITES.test(tool)) return `tool "${tool}" looks like one that writes; memory sources only read`
}

const pick = (item: Record<string, unknown>) => {
  for (const key of ["fact", "text", "content", "memory", "summary", "description", "name"]) {
    const value = item[key]
    if (typeof value === "string" && value.trim()) return value
  }
}

/**
 * The results of a tool call as separate items, so each is screened on its own. Understands the
 * common memory-server shapes (a knowledge graph's `entities` and `relations`, a list of `facts`
 * or memories) and falls back to one item per paragraph of text.
 */
export function items(result: { content?: unknown; structuredContent?: unknown }): string[] {
  const out: string[] = []
  const visit = (value: unknown, depth = 0): void => {
    if (value === null || value === undefined || depth > 4) return
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed) return
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && depth === 0) {
        try {
          return visit(JSON.parse(trimmed), depth + 1)
        } catch {}
      }
      for (const paragraph of trimmed.split(/\n\s*\n/)) if (paragraph.trim()) out.push(paragraph.trim())
      return
    }
    if (typeof value === "number" || typeof value === "boolean") return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    if (Array.isArray(record.entities) || Array.isArray(record.relations)) {
      for (const entity of (record.entities as Record<string, unknown>[] | undefined) ?? []) {
        const observations = Array.isArray(entity.observations) ? entity.observations.map(String).join("; ") : ""
        out.push(
          `${String(entity.name ?? "")}${entity.entityType ? ` [${String(entity.entityType)}]` : ""}${observations ? `: ${observations}` : ""}`,
        )
      }
      for (const relation of (record.relations as Record<string, unknown>[] | undefined) ?? [])
        out.push(`${String(relation.from ?? "")} ${String(relation.relationType ?? "")} ${String(relation.to ?? "")}`)
      return
    }
    for (const key of ["facts", "results", "memories", "items", "nodes", "edges", "episodes"])
      if (Array.isArray(record[key])) {
        for (const item of record[key] as unknown[]) visit(item, depth + 1)
        return
      }
    const text = pick(record)
    if (text) out.push(text.trim())
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) visit(result.structuredContent)
  else
    for (const part of Array.isArray(result.content) ? result.content : [])
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text")
        visit((part as { text?: unknown }).text)
  return out
}

export async function connect(input: {
  source: ConfigMemorySource.Info & { server: string; tool: string }
  server: ConfigMCPV1.Info
  directory: string
}): Promise<Client> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const client = new Client({ name: "lunos-memory-source", version: "1" }, { capabilities: {} })
  const { server, source } = input
  const transport =
    server.type === "local"
      ? new (await import("@modelcontextprotocol/sdk/client/stdio.js")).StdioClientTransport({
          stderr: "ignore",
          command: server.command[0],
          args: server.command.slice(1),
          cwd: server.cwd ? path.resolve(input.directory, server.cwd) : input.directory,
          env: { ...(process.env as Record<string, string>), ...server.environment },
        })
      : new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(
          new URL(server.url),
          { requestInit: server.headers ? { headers: server.headers } : undefined },
        )
  try {
    // A server that never finishes its handshake is given up on (and its process stopped), so the
    // next turn can try again instead of waiting on it forever.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MCP server "${source.server}" did not start within ${CONNECT_TIMEOUT_MS} ms`)),
          CONNECT_TIMEOUT_MS,
        )
      }),
    ]).finally(() => clearTimeout(timer))
    const listed = await client.listTools()
    const tool = listed.tools.find((item) => item.name === source.tool)
    if (!tool) throw new Error(`MCP server "${source.server}" offers no tool "${source.tool}"`)
    const refusal = writeShaped(tool.name, tool.annotations)
    if (refusal) throw new Error(refusal)
  } catch (error) {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
    throw error
  }
  return {
    async search(query, timeoutMs) {
      const result = await client.callTool(
        { name: source.tool, arguments: { [source.argument ?? "query"]: query } },
        undefined,
        { timeout: timeoutMs },
      )
      if (result.isError) throw new Error(`tool "${source.tool}" returned an error`)
      return items(result)
    },
    close: () => client.close(),
  }
}
