import { describe, expect, test } from "bun:test"
import { brandHelp } from "../../src/cli/brand"

describe("brandHelp (XCOD-127)", () => {
  test("renames the product in upstream's command descriptions", () => {
    expect(brandHelp("  lunos [project]   start opencode tui")).toBe("  lunos [project]   start Lunos tui")
    expect(brandHelp("run opencode with a message")).toBe("run Lunos with a message")
    expect(brandHelp("attach to a running opencode server (e.g., http://localhost:4096)")).toBe(
      "attach to a running Lunos server (e.g., http://localhost:4096)",
    )
  })

  test("keeps every identifier the binary still reads", () => {
    const kept = [
      "custom domain name for mDNS service (default: opencode.local)",
      "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      "where to write them (default: .opencode/memory/export)",
      '[default: "/home/me/src/packages/opencode"]',
      "reads opencode.json and opencode.jsonc",
      "the opencode-ai package and @opencode-ai/sdk",
    ]
    for (const line of kept) expect(brandHelp(line)).toBe(line)
  })
})

test("keeps help columns aligned", () => {
  const before = "  lunos attach <url>        attach to a running opencode server  [string]"
  const after = brandHelp(before)
  expect(after).toBe("  lunos attach <url>        attach to a running Lunos server     [string]")
  expect(after.length).toBe(before.length)
})
