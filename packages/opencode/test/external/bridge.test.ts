// XCOD-254: the Lunos bridge's two halves: the host's socket protocol, and `lunos mcp bridge` as a
// real stdio MCP server (spawned from source, spoken to with the MCP SDK's client).
import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { ExternalBridge } from "../../src/external/bridge"

const tools: ExternalBridge.ToolDef[] = [
  {
    name: "lunos__echo__say",
    description: 'From Lunos\'s MCP server "echo". Says it back',
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
]

function engine(calls: unknown[] = []): ExternalBridge.Engine {
  return {
    list: async () => tools,
    call: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: "text", text: `said ${String(args.text)}` }] }
    },
  }
}

describe("ExternalBridge names and status", () => {
  test("MCP tools are lunos__<server>__<tool>, cut with a hash to fit the tool's 64 characters", () => {
    expect(ExternalBridge.mcpName("github", "create_issue")).toBe("lunos__github__create_issue")
    expect(ExternalBridge.mcpName("my server", "do.it")).toBe("lunos__my_server__do_it")
    const long = ExternalBridge.mcpName("a".repeat(40), "b".repeat(40))
    const other = ExternalBridge.mcpName("a".repeat(40), "b".repeat(39) + "c")
    expect(long.length).toBeLessThanOrEqual(ExternalBridge.NAME_LIMIT)
    expect(`mcp__lunos__${long}`.length).toBeLessThanOrEqual(64)
    expect(long).not.toBe(other)
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test("the status line, with the warning when the tool didn't connect", () => {
    expect(ExternalBridge.line({ servers: 2, skills: 1, memory: true, connected: true })).toBe(
      "Lunos bridge: 2 servers, 1 skill, memory on",
    )
    expect(ExternalBridge.line({ servers: 1, skills: 0, memory: false, connected: false })).toBe(
      "Lunos bridge: 1 server, 0 skills, memory off ⚠ not connected",
    )
    expect(ExternalBridge.line({ servers: 0, skills: 0, memory: false, off: "not shared" })).toBe(
      "Lunos bridge: off (not shared)",
    )
    expect(ExternalBridge.line(undefined)).toBeUndefined()
  })

  test("Codex gets an mcp_servers override; Claude Code a private --mcp-config file", async () => {
    const host = { socket: "/tmp/x/s", token: "t0k" }
    const codex = ExternalBridge.codexConfig("ses_1", host)
    expect(Object.keys(codex)).toEqual(["mcp_servers.lunos"])
    expect(codex["mcp_servers.lunos"]!.args.slice(-4)).toEqual(["mcp", "bridge", "--session", "ses_1"])
    expect(codex["mcp_servers.lunos"]!.env).toEqual({ LUNOS_BRIDGE_SOCKET: "/tmp/x/s", LUNOS_BRIDGE_TOKEN: "t0k" })
    const claude = await ExternalBridge.claudeConfig("ses_1", host)
    const parsed = JSON.parse(await Bun.file(claude.file).text())
    expect(parsed.mcpServers.lunos).toMatchObject({ type: "stdio", env: { LUNOS_BRIDGE_TOKEN: "t0k" } })
    if (process.platform !== "win32") {
      const { statSync } = await import("fs")
      expect(statSync(claude.file).mode & 0o077).toBe(0)
    }
    await claude.remove()
    expect(existsSync(claude.file)).toBe(false)
  })
})

describe("ExternalBridge host", () => {
  test("refuses a wrong token or another session, then serves the right one", async () => {
    const calls: unknown[] = []
    let connects = 0
    const host = await ExternalBridge.serve({ session: "ses_a", engine: engine(calls), onConnect: () => connects++ })
    try {
      expect(host.connected()).toBe(false)
      await expect(ExternalBridge.connect({ socket: host.socket, token: "wrong", session: "ses_a" })).rejects.toThrow(
        "Not a Lunos bridge",
      )
      await expect(
        ExternalBridge.connect({ socket: host.socket, token: host.token, session: "ses_b" }),
      ).rejects.toThrow("Not a Lunos bridge")
      expect(host.connected()).toBe(false)

      const client = await ExternalBridge.connect({ socket: host.socket, token: host.token, session: "ses_a" })
      expect(host.connected()).toBe(true)
      expect(connects).toBe(1)
      expect(await client.list()).toEqual(tools)
      expect(await client.call("lunos__echo__say", { text: "hi" })).toEqual({
        content: [{ type: "text", text: "said hi" }],
      })
      expect(calls).toEqual([{ name: "lunos__echo__say", args: { text: "hi" } }])
      const changed = new Promise<void>((resolve) => client.onChanged(resolve))
      host.changed()
      await changed
      client.close()
    } finally {
      await host.close()
    }
    if (process.platform !== "win32") expect(existsSync(host.socket)).toBe(false)
  })
})

describe("lunos mcp bridge", () => {
  test("is an MCP server over stdio: lists and calls through the host, and passes on list_changed", async () => {
    const calls: unknown[] = []
    const host = await ExternalBridge.serve({ session: "ses_stdio", engine: engine(calls) })
    const entry = ExternalBridge.entry("ses_stdio", host)
    const client = new Client({ name: "test", version: "1" })
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      env: { ...(process.env as Record<string, string>), ...entry.env },
      stderr: "pipe",
    })
    try {
      // Any stray stdout line would break the MCP framing, and connecting would fail.
      await client.connect(transport)
      expect(client.getServerCapabilities()?.tools).toMatchObject({ listChanged: true })
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(["lunos__echo__say"])
      const result = await client.callTool({ name: "lunos__echo__say", arguments: { text: "hello" } })
      expect(result.content).toEqual([{ type: "text", text: "said hello" }])
      expect(calls).toEqual([{ name: "lunos__echo__say", args: { text: "hello" } }])
      const changed = new Promise<void>((resolve) =>
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
      )
      host.changed()
      await changed
    } finally {
      await client.close().catch(() => undefined)
      await host.close()
    }
  }, 30_000)
})
