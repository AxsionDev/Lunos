// XCOD-254: what the fake tools do with the Lunos bridge they're given: start it the way Claude Code
// and Codex start a stdio MCP server (the user's environment plus the entry's `env`), list its
// tools, and call one. Not recorded: the real tools' MCP clients aren't driven here.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

export interface Entry {
  command: string
  args: string[]
  env?: Record<string, string>
}

export async function useBridge(entry: Entry, call?: { name: string; arguments: Record<string, unknown> }) {
  const client = new Client({ name: "fake-tool", version: "1" })
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...(process.env as Record<string, string>), ...entry.env },
    stderr: "pipe",
  })
  await client.connect(transport)
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    const result = call ? await client.callTool(call) : undefined
    return { tools, result }
  } finally {
    await client.close().catch(() => undefined)
  }
}
