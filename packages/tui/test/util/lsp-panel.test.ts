import { describe, expect, test } from "bun:test"
import type { LspServerInfo } from "@opencode-ai/sdk/v2"
import { LspPanel } from "../../src/util/lsp-panel"

// XCOD-257: what /lsp says about each language server.

const server = (fields: Partial<LspServerInfo>): LspServerInfo =>
  ({ id: "gopls", extensions: [".go"], state: "not_started", custom: false, ...fields }) as LspServerInfo

describe("LSP panel", () => {
  test("states in words, grouped active first", () => {
    expect(LspPanel.label({ state: "failed" })).toBe("Failed")
    expect(LspPanel.label({ state: "not_started" })).toBe("Not started")
    expect(LspPanel.group({ state: "running" })).toBe("Active")
    expect(LspPanel.group({ state: "disabled" })).toBe("Off")
  })

  test("a failed server's row and detail say why", () => {
    const failed = server({ state: "failed", reason: "command not found: gopls" })
    expect(LspPanel.describe(failed)).toBe("command not found: gopls")
    expect(LspPanel.details(failed)[0]).toBe("Failed: command not found: gopls")
  })

  test("a running server shows its source, root, pid and uptime", () => {
    const running = server({
      state: "running",
      source: "PATH (/usr/bin/gopls)",
      root: ".",
      pid: 42,
      started: 1000,
      diagnostics: 3,
    })
    expect(LspPanel.describe(running)).toBe("PATH (/usr/bin/gopls) · 3 diagnostics")
    expect(LspPanel.details(running, 1000 + 125_000)).toEqual([
      "Files: .go",
      "From: PATH (/usr/bin/gopls)",
      "Project root: .",
      "PID 42, up 2m",
      "3 diagnostics in the files it has open",
    ])
  })

  test("the summary counts states and diagnostics", () => {
    expect(
      LspPanel.summary({
        servers: [server({ state: "running", diagnostics: 2 }), server({ state: "failed" }), server({})],
      }),
    ).toBe("1 running · 1 failed · 1 not started · 2 diagnostics given to the agent")
  })
})
