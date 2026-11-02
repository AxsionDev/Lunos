#!/usr/bin/env bun
// XCOD-254: a Lunos MCP server for tests (configured under `mcp` as a local server). One tool,
// `say`, which answers "said <text>".
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "echo", version: "1" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "say",
      description: "Says the text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: `said ${String(request.params.arguments?.text ?? "")}` }],
}))
await server.connect(new StdioServerTransport())
