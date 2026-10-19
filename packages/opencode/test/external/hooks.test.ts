import { describe, expect, test } from "bun:test"
import { ExternalHooks } from "../../src/external/hooks"
import { ExternalCodex } from "../../src/external/codex"

describe("the tool's calls as Lunos hooks see them (XCOD-254)", () => {
  test("Claude Code's tools take Lunos's names and argument names", () => {
    expect(ExternalHooks.call("claude", "Bash", { command: "rm -rf build", description: "Clean" })).toEqual({
      tool: "bash",
      args: { command: "rm -rf build", description: "Clean" },
    })
    expect(
      ExternalHooks.call("claude", "Edit", {
        file_path: "/w/a.ts",
        old_string: "a",
        new_string: "b",
        replace_all: true,
      }),
    ).toEqual({ tool: "edit", args: { filePath: "/w/a.ts", oldString: "a", newString: "b", replaceAll: true } })
    // No Lunos counterpart: the tool's own name, arguments as given.
    expect(ExternalHooks.call("claude", "mcp__github__create_issue", { title: "Bug" })).toEqual({
      tool: "mcp__github__create_issue",
      args: { title: "Bug" },
    })
  })

  test("Codex: a command given as argv is one string; a file change names its first file", () => {
    expect(ExternalHooks.call("codex", "Bash", { command: ["rm", "-rf", "build"] })).toEqual({
      tool: "bash",
      args: { command: "rm -rf build" },
    })
    const changes = [{ path: "/w/a.ts" }, { path: "/w/b.ts" }]
    expect(ExternalHooks.call("codex", "FileChange", { file_path: "/w/a.ts, /w/b.ts", changes })).toEqual({
      tool: "apply_patch",
      args: { filePath: "/w/a.ts", files: ["/w/a.ts", "/w/b.ts"], changes },
    })
  })

  test("a hook's error is the refusal the tool gets", () => {
    expect(ExternalHooks.refusal(new Error("no rm -rf"))).toBe("Refused by a Lunos hook: no rm -rf")
  })
})

describe("Codex's MCP tool call approvals (XCOD-254, unverified against 0.160.1)", () => {
  const items = new Map<string, any>([
    [
      "mcp-1",
      { id: "mcp-1", type: "mcpToolCall", server: "github", tool: "create_issue", arguments: { title: "Bug" } },
    ],
  ])

  test("an elicitation marked as a tool call's approval: the call it's for, and an accept or decline", () => {
    const approval = ExternalCodex.mcpApproval(
      "mcpServer/elicitation/request",
      { serverName: "github", request: { message: "Run it?", _meta: { codex_approval_kind: "mcp_tool_call" } } },
      items,
    )!
    expect(approval).toMatchObject({
      tool: "mcp__github__create_issue",
      input: { title: "Bug" },
      description: "Run it?",
      itemID: "mcp-1",
    })
    expect(approval.reply(true)).toEqual({ action: "accept", content: {} })
    expect(approval.reply(false)).toEqual({ action: "decline", content: null })
  })

  test("a question: answered with its one-call options, never a standing one", () => {
    const approval = ExternalCodex.mcpApproval(
      "item/tool/requestUserInput",
      {
        itemId: "mcp-1",
        questions: [
          {
            id: "mcp_tool_call_approval_mcp-1",
            question: "Run it?",
            options: [{ label: "Allow for this session" }, { label: "Allow" }, { label: "Cancel" }],
          },
        ],
      },
      items,
    )!
    expect(approval.tool).toBe("mcp__github__create_issue")
    expect(approval.reply(true)).toEqual({ answers: { "mcp_tool_call_approval_mcp-1": { answers: ["Allow"] } } })
    expect(approval.reply(false)).toEqual({ answers: { "mcp_tool_call_approval_mcp-1": { answers: ["Cancel"] } } })
  })

  test("anything else is not an approval, so it's still refused", () => {
    // A server asking the user for input, not an approval.
    expect(
      ExternalCodex.mcpApproval("mcpServer/elicitation/request", { serverName: "github", request: {} }, items),
    ).toBeUndefined()
    // A question that isn't an approval, or whose options can't be read.
    expect(
      ExternalCodex.mcpApproval("item/tool/requestUserInput", { questions: [{ id: "pick_a_color" }] }, items),
    ).toBeUndefined()
    expect(
      ExternalCodex.mcpApproval(
        "item/tool/requestUserInput",
        { questions: [{ id: "mcp_tool_call_approval_x", options: [{ label: "Maybe" }] }] },
        items,
      ),
    ).toBeUndefined()
    expect(ExternalCodex.mcpApproval("item/tool/call", {}, items)).toBeUndefined()
  })
})
