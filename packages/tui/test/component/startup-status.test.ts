import { describe, expect, test } from "bun:test"
import { startupStatus } from "../../src/component/startup-status"

// XCOD-276: the line under the app while start-up work finishes behind the first frame.
describe("startupStatus", () => {
  const base = { status: "complete" as const, plugins: true, configured: [], failedShown: true }

  test("nothing once everything has loaded", () => {
    expect(startupStatus(base)).toBeUndefined()
  })

  test("the server's data, plugins and MCP servers, while they load", () => {
    expect(startupStatus({ ...base, status: "loading", plugins: false, configured: ["a", "b", "c"] })).toBe(
      "Starting… · plugins loading · MCP connecting… (3)",
    )
    expect(startupStatus({ ...base, status: "partial", configured: ["a"] })).toBe("MCP connecting… (1)")
  })

  test("names the MCP servers that didn't connect, for a while", () => {
    const mcp = { a: { status: "connected" }, b: { status: "failed" }, c: { status: "failed" } }
    expect(startupStatus({ ...base, configured: ["a", "b", "c"], mcp })).toBe("MCP b, c didn't connect")
    expect(startupStatus({ ...base, configured: ["a", "b", "c"], mcp, failedShown: false })).toBeUndefined()
    expect(startupStatus({ ...base, configured: ["a"], mcp: { a: { status: "connected" } } })).toBeUndefined()
  })
})
