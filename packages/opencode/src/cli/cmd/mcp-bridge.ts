import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ExternalBridge } from "@/external/bridge"
import { cmd } from "./cmd"

/**
 * XCOD-254: `lunos mcp bridge --session <id>`, the stdio MCP server Claude Code or Codex starts from
 * the config Lunos hands it for one turn. It relays to the Lunos session that started the tool (the
 * socket and token come in its environment) and holds no state of its own; when that session's turn
 * ends, it exits. stdout carries MCP only, so nothing else is printed there.
 */
export async function bridge(session: string, env: NodeJS.ProcessEnv = process.env) {
  const socket = env[ExternalBridge.ENV_SOCKET]
  const token = env[ExternalBridge.ENV_TOKEN]
  if (!socket || !token) throw new Error("lunos mcp bridge is started by Lunos for a Claude Code or Codex session")
  const host = await ExternalBridge.connect({ socket, token, session })
  const server = new Server(
    { name: "lunos", version: InstallationVersion },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Tools from Lunos, the coding agent that started this session: its MCP servers (lunos__<server>__<tool>), skills and memory. Each call asks the user in Lunos.",
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await host.list() }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await host.call(request.params.name, request.params.arguments ?? {}).catch((error: unknown) => ({
      content: [{ type: "text" as const, text: `Lunos: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    }))
    return result as any
  })
  host.onChanged(() => void server.sendToolListChanged().catch(() => undefined))
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    host.onClose(resolve)
    transport.onclose = () => resolve()
    process.stdin.on("end", () => resolve())
  })
  host.close()
  await server.close().catch(() => undefined)
}

export const McpBridgeCommand = cmd({
  command: "bridge",
  describe: "the MCP server Lunos gives Claude Code and Codex sessions (started by Lunos, not by hand)",
  builder: (yargs) =>
    yargs.option("session", { type: "string", demandOption: true, describe: "the Lunos session it serves" }),
  async handler(args) {
    try {
      await bridge(String(args.session))
      process.exit(0)
    } catch (error) {
      process.stderr.write(`lunos mcp bridge: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
  },
})
