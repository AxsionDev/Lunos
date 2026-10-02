import { describe, expect, test } from "bun:test"
import { closest, unknownToolError, UNKNOWN } from "../../src/tool/invalid"
import { Permission } from "../../src/permission"

// XCOD-167: an MCP server can add ~30 tools to every session; small models then call tools that
// don't exist.
describe("unknown tools", () => {
  const tools = ["read", "edit", "bash", "grep", "memory_search", "memory_remember", "docs_search_pages", "invalid"]

  test("a made-up name gets the nearest real tools, not an 'invalid arguments' error", () => {
    expect(closest("memory_serch", tools)[0]).toBe("memory_search")
    expect(closest("search_docs", tools)).toContain("docs_search_pages")
    expect(closest("x", tools)).not.toContain("invalid")
    const error = unknownToolError("memory_serch", tools)
    expect(error.startsWith(UNKNOWN)).toBe(true)
    expect(error).toContain('"memory_serch"')
    expect(error).toContain("memory_search")
  })

  test("a project or agent can drop an MCP server's tools with one rule", () => {
    const mcp = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`bigserver_tool_${i}`, true]))
    const all = { read: true, bash: true, ...mcp }
    const visible = Permission.visibleTools(all, Permission.fromConfig({ "*": "allow", "bigserver_*": "deny" }))
    expect(Object.keys(visible).sort()).toEqual(["bash", "read"])
    // The legacy `tools` map form does the same: { "bigserver_*": false } becomes a deny rule.
    expect(Object.keys(Permission.visibleTools(all, Permission.fromConfig({ "bigserver_*": "deny" }))).length).toBe(2)
  })
})
