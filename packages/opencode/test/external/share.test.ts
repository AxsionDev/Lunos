// XCOD-254: consent per tool and project, the share keys, and what the bridge offers and asks.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigExternal } from "@opencode-ai/core/config/external"
import { Global } from "@opencode-ai/core/global"
import { ExternalConsent } from "../../src/external/consent"
import { ExternalBridgeTools } from "../../src/external/bridge-tools"
import { ExternalClaude } from "../../src/external/claude"
import { ConfigPolicy } from "../../src/config/policy"

describe("external.share", () => {
  test("every key is on unless set to false, and each can be locked", () => {
    expect(ConfigExternal.share(undefined)).toEqual({
      mcp: true,
      skills: true,
      memory: true,
      commands: true,
      hooks: true,
    })
    expect(ConfigExternal.share({ share: { memory: false } })).toMatchObject({ memory: false, mcp: true })
    for (const key of ["external.share", ...ConfigExternal.SHARE.map((item) => `external.share.${item}`)])
      expect(ConfigPolicy.isKnown(key)).toBe(true)
  })
})

describe("ExternalConsent", () => {
  test("kept per tool and project in Lunos's state directory, never in config; ask forgets it", async () => {
    await fs.rm(path.join(Global.Path.state, "external-consent.json"), { force: true })
    const a = ExternalConsent.project({ project: { id: "prj_a" }, directory: "/a" })
    const b = ExternalConsent.project({ project: { id: "global" }, directory: "/b" })
    expect(b).toBe("global:/b")
    expect(await ExternalConsent.get(a, "claude")).toBeUndefined()
    await ExternalConsent.set(a, "claude", "share")
    await ExternalConsent.set(b, "claude", "never")
    expect(await ExternalConsent.get(a, "claude")).toBe("share")
    expect(await ExternalConsent.get(a, "codex")).toBeUndefined()
    expect(await ExternalConsent.get(b, "claude")).toBe("never")
    await ExternalConsent.set(a, "claude", undefined)
    expect(await ExternalConsent.get(a, "claude")).toBeUndefined()
    const file = path.join(Global.Path.state, "external-consent.json")
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o077).toBe(0)
  })

  test("the question offers Share, Not now and Never; a dismissed question is Not now", () => {
    const question = ExternalConsent.question("Claude Code", "Anthropic")
    expect(question.question).toBe(
      "Share Lunos tools, skills and memory with Claude Code? Their results are sent to Anthropic with your prompts.",
    )
    expect(question.options.map((item) => item.label)).toEqual(["Share", "Not now", "Never for this tool"])
    expect(ExternalConsent.parse([["Share"]])).toBe("share")
    expect(ExternalConsent.parse([["Never for this tool"]])).toBe("never")
    expect(ExternalConsent.parse([["Not now"]])).toBe("later")
    expect(ExternalConsent.parse(undefined)).toBe("later")
  })
})

describe("ExternalBridgeTools", () => {
  test("a bridged call asks unless a rule names the tool; deny and ask rules stay", () => {
    const all = [{ permission: "*", pattern: "*", action: "allow" as const }]
    expect(ExternalBridgeTools.askUnlessNamed(all, "echo_say", ["*"]).at(-1)).toEqual({
      permission: "echo_say",
      pattern: "*",
      action: "ask",
    })
    const named = [...all, { permission: "echo_say", pattern: "*", action: "allow" as const }]
    expect(ExternalBridgeTools.askUnlessNamed(named, "echo_say", ["*"])).toBe(named)
    const denied = [...all, { permission: "echo_*", pattern: "*", action: "deny" as const }]
    expect(ExternalBridgeTools.askUnlessNamed(denied, "echo_say", ["*"])).toBe(denied)
    const skill = [...all, { permission: "skill", pattern: "deploy", action: "allow" as const }]
    expect(ExternalBridgeTools.askUnlessNamed(skill, "skill", ["deploy"])).toBe(skill)
    expect(ExternalBridgeTools.askUnlessNamed(skill, "skill", ["other"]).length).toBe(skill.length + 1)
  })

  test("under a residency policy a remote MCP server needs an allowed region; a local one runs here", () => {
    const config = {
      residency: { allow: ["eu" as const], endpoints: { "mcp:near": { region: "eu" as const } } },
      mcp: {
        local: { type: "local", command: ["x"] },
        near: { type: "remote", url: "https://near.example.eu/mcp" },
        far: { type: "remote", url: "https://far.example.com/mcp" },
      },
    }
    expect(ExternalBridgeTools.mcpRefused("local", config)).toBeUndefined()
    expect(ExternalBridgeTools.mcpRefused("near", config)).toBeUndefined()
    expect(ExternalBridgeTools.mcpRefused("far", config)).toMatch(/no recorded data-processing jurisdiction/)
    expect(ExternalBridgeTools.mcpRefused("far", { mcp: config.mcp })).toBeUndefined()
  })

  test("lunos external list's line: off until asked, off when never, counts once shared", () => {
    const config = {
      mcp: { a: { type: "local" }, b: { type: "local", enabled: false } },
      model: "anthropic/claude-sonnet-5-5",
    }
    const base = { tool: "codex" as const, config, skills: 2, memory: true }
    expect(ExternalBridgeTools.preview({ ...base, consent: undefined }).off).toMatch(/not shared yet/)
    expect(ExternalBridgeTools.preview({ ...base, consent: "never" }).off).toMatch(/never/)
    expect(ExternalBridgeTools.preview({ ...base, consent: "share" })).toEqual({ servers: 1, skills: 2, memory: true })
    expect(
      ExternalBridgeTools.preview({
        ...base,
        consent: "share",
        config: { ...config, external: { share: { memory: false } } },
      }),
    ).toEqual({ servers: 1, skills: 2, memory: false })
    expect(ExternalBridgeTools.preview({ ...base, consent: "share", refused: "external sessions are off" }).off).toBe(
      "external sessions are off",
    )
    expect(ExternalBridgeTools.preview({ ...base, tool: "claude", consent: "share", mcpConfig: false }).off).toMatch(
      /--mcp-config/,
    )
  })
})

describe("Claude Code and the bridge", () => {
  test("--mcp-config only with a path that is safe on a command line; never --strict-mcp-config", () => {
    const args = ExternalClaude.args({ mcpConfig: "/tmp/lunos-mcp-x/mcp.json" })
    expect(args.slice(-2)).toEqual(["--mcp-config", "/tmp/lunos-mcp-x/mcp.json"])
    expect(args).not.toContain("--strict-mcp-config")
    expect(ExternalClaude.args({}).includes("--mcp-config")).toBe(false)
    expect(() => ExternalClaude.args({ mcpConfig: "/tmp/a b/mcp.json" })).toThrow("can't be passed")
    expect(() => ExternalClaude.args({ mcpConfig: "/tmp/a;rm/mcp.json" })).toThrow("can't be passed")
  })

  test("the init event reports the MCP servers' state when Claude Code lists them (not recorded)", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s",
      tools: [],
      mcp_servers: [{ name: "lunos", status: "connected" }],
    })
    expect(ExternalClaude.parse(line).events[0]).toMatchObject({ mcp: [{ name: "lunos", status: "connected" }] })
  })
})
