// XCOD-256: what a run takes from external.* config, asserted on the launch arguments each tool
// gets: blank is the default, a refused value falls back to it, Codex's new keys beat the legacy one.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigExternal } from "@opencode-ai/core/config/external"
import { ExternalClaude } from "@/external/claude"
import { ExternalCodex } from "@/external/codex"
import { ExternalDetect } from "@/external/detect"

const claudeMode = (config: ConfigExternal.Info) => {
  const args = ExternalClaude.args(ConfigExternal.launch("claude", config))
  return args[args.indexOf("--permission-mode") + 1]
}
const codex = (config: ConfigExternal.Info) => ExternalCodex.settings(ConfigExternal.launch("codex", config))
const decode = Schema.decodeUnknownSync(ConfigExternal.Info)

describe("external permission config (XCOD-256)", () => {
  test("unset, empty and blank all start Claude Code with manual approval (default)", () => {
    expect(claudeMode({})).toBe("default")
    expect(claudeMode(decode({ claude: { permission_mode: "" } }))).toBe("default")
    expect(claudeMode(decode({ claude: { permission_mode: "   " } }))).toBe("default")
    expect(claudeMode({ claude: { permission_mode: "acceptEdits" } })).toBe("acceptEdits")
  })

  test("a refused value in config is replaced by the safe default instead of failing the run", () => {
    expect(claudeMode({ claude: { permission_mode: "bypassPermissions" } })).toBe("default")
    expect(codex({ codex: { sandbox: "danger-full-access", approval_policy: "never" } })).toEqual({
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    })
    // Per run, the unsafe mode still needs --unsafe.
    expect(() => ExternalClaude.args({ permissionMode: "bypassPermissions" })).toThrow(/--unsafe/)
  })

  test("Codex: unset and blank are read-only + untrusted; the new keys are used as set", () => {
    expect(codex({})).toEqual({ sandbox: "read-only", approvalPolicy: "untrusted" })
    expect(codex(decode({ codex: { sandbox: " ", approval_policy: "" } }))).toEqual({
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    })
    expect(codex({ codex: { sandbox: "workspace-write", approval_policy: "on-request" } })).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    })
  })

  test("Codex's legacy permission_mode is read as a sandbox or an approval policy, and the new keys win", () => {
    expect(codex({ codex: { permission_mode: "workspace-write" } })).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
    })
    expect(codex({ codex: { permission_mode: "on-request" } })).toEqual({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    })
    expect(codex({ codex: { permission_mode: "on-request", approval_policy: "untrusted" } }).approvalPolicy).toBe(
      "untrusted",
    )
  })

  test("the schema takes the known values and blanks, and rejects anything else", () => {
    expect(() => decode({ claude: { permission_mode: "plan" } })).not.toThrow()
    expect(() => decode({ claude: { permission_mode: "bypassPermissions" } })).not.toThrow()
    expect(() => decode({ claude: { permission_mode: "planning" } })).toThrow()
    expect(() => decode({ codex: { sandbox: "full" } })).toThrow()
  })

  test("saving sandbox or approval_policy moves the legacy key, carrying a safe value to the other one", () => {
    expect(ConfigExternal.migrate("external.codex.sandbox", { permission_mode: "on-request" })).toEqual([
      { key: "external.codex.approval_policy", value: "on-request" },
      { key: "external.codex.permission_mode", unset: true },
    ])
    expect(ConfigExternal.migrate("external.codex.approval_policy", { permission_mode: "workspace-write" })).toEqual([
      { key: "external.codex.sandbox", value: "workspace-write" },
      { key: "external.codex.permission_mode", unset: true },
    ])
    // Already set, or refused: not carried, only removed.
    expect(
      ConfigExternal.migrate("external.codex.sandbox", { permission_mode: "on-request", approval_policy: "untrusted" }),
    ).toEqual([{ key: "external.codex.permission_mode", unset: true }])
    expect(ConfigExternal.migrate("external.codex.sandbox", { permission_mode: "never" })).toEqual([
      { key: "external.codex.permission_mode", unset: true },
    ])
    expect(ConfigExternal.migrate("external.codex.sandbox", {})).toEqual([])
  })

  test("labels never show an empty mode", () => {
    expect(ConfigExternal.label(undefined, "default")).toBe("Manual approval (default)")
    expect(ConfigExternal.label("", "default")).toBe("Manual approval (default)")
    expect(ConfigExternal.label("manual", "default")).toBe("Manual approval (default)")
    expect(ConfigExternal.label("plan", "default")).toBe("plan")
  })

  test("Claude Code's --permission-mode choices are read from --help, wrapped across lines", () => {
    const help = `  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --plugin-dir <path>                   Load plugins`
    expect(ExternalDetect.permissionModes(help)).toEqual([
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "manual",
      "dontAsk",
      "plan",
    ])
    expect(ExternalDetect.permissionModes("  --model <model>  Model")).toBeUndefined()
  })
})
