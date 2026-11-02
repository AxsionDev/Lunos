import { describe, expect, test } from "bun:test"
import { choices, CLAUDE_FALLBACK, perRun } from "../../src/util/external-permission"

// XCOD-256: what /settings offers for Claude Code's permission mode and Codex's sandbox and approval.

describe("external permission choices", () => {
  test("Claude Code: manual approval first, then what this install accepts, unsafe greyed", () => {
    const list = choices("external.claude.permission_mode", [
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "manual",
      "dontAsk",
      "plan",
    ])
    expect(list.map((item) => item.value)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ])
    expect(list[0]).toMatchObject({ title: "Manual approval (default)", default: true })
    expect(list.filter((item) => item.unsafe).map((item) => item.value)).toEqual(["bypassPermissions"])
  })

  test("without a readable claude --help: the common modes, and the unsafe one still listed", () => {
    expect(CLAUDE_FALLBACK).toEqual(["default", "acceptEdits", "plan"])
    expect(choices("external.claude.permission_mode").map((item) => item.value)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ])
  })

  test("`manual` is the default under Claude Code's newer name: listed only when it's what's set", () => {
    const detected = ["acceptEdits", "manual", "plan"]
    expect(choices("external.claude.permission_mode", detected).map((item) => item.value)).not.toContain("manual")
    expect(choices("external.claude.permission_mode", detected, "manual").map((item) => item.value)).toContain("manual")
  })

  test("Codex: sandbox and approval policy, each with its safe default first", () => {
    expect(choices("external.codex.sandbox").map((item) => [item.value, !!item.default, !!item.unsafe])).toEqual([
      ["read-only", true, false],
      ["workspace-write", false, false],
      ["danger-full-access", false, true],
    ])
    expect(choices("external.codex.approval_policy").map((item) => item.value)).toEqual([
      "untrusted",
      "on-request",
      "never",
    ])
    expect(perRun("never")).toBe("Only per run: lunos external run … --permission-mode never --unsafe")
  })

  test("other keys have no choices", () => {
    expect(choices("external.codex.permission_mode")).toEqual([])
  })
})
