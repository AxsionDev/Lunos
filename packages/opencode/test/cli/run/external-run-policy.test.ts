// XCOD-293: `lunos external run` registers the same Lunos policy as a /claude session (Claude Code's
// PreToolUse hook): a Lunos deny rule or plugin pre-tool hook refuses a call Claude Code's permission
// mode would allow without asking, and the refusal is audited. The fake claude
// (test/external/fixtures/fake-claude.ts) runs `rm -rf build` through Bash in such a mode.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

const FAKE = path.join(import.meta.dir, "..", "..", "external", "fixtures", "fake-claude.ts")
const TIMEOUT = 120_000
const CHILD_TIMEOUT = 90_000

const readLines = (file: string) =>
  (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

/** Refuses `rm -rf` in bash, as a Lunos user's guard plugin would. */
const GUARD = `export const Guard = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool === "bash" && /rm -rf/.test(String(output.args?.command ?? "")))
      throw new Error("rm -rf is not allowed in this project")
  },
})
`

const setup = (home: string, llmUrl: string, extra: Record<string, unknown> = {}) => {
  const log = path.join(home, "fake-claude.log")
  const audit = path.join(home, "audit.log")
  const config = JSON.stringify({
    ...testProviderConfig(llmUrl),
    external: { claude: { path: FAKE } },
    audit: { enabled: true, path: audit },
    ...extra,
  })
  return {
    log,
    audit,
    env: {
      OPENCODE_CONFIG_CONTENT: config,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_BASH: "rm -rf build",
      // The tool's mode allows the call by itself: no can_use_tool, only the PreToolUse hook reaches Lunos.
      FAKE_CLAUDE_AUTO_ALLOW: "1",
    },
  }
}

const RUN = ["external", "run", "claude", "Clean the build"]
const DENY = { permission: { external: { "*": "allow", "claude:Bash rm -rf*": "deny" } } }

describe("lunos external run applies Lunos policy before Claude Code's permission mode (XCOD-293)", () => {
  cliIt.concurrent(
    "a Lunos deny rule refuses a call Claude Code would allow by itself, and is audited",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const { log, audit, env } = setup(home, llm.url, DENY)
        const result = yield* opencode.spawn(RUN, { timeoutMs: CHILD_TIMEOUT, env })
        opencode.expectExit(result, 0)
        const sent = readLines(log)
        const init = sent.find((line) => line.request?.subtype === "initialize")
        expect(init.request.hooks).toEqual({ PreToolUse: [{ hookCallbackIds: ["lunos-policy"] }] })
        const hook = sent.find((line) => line.response?.request_id === "hook_toolu_bash").response.response
        expect(hook.hookSpecificOutput.permissionDecisionReason).toMatch(/^Blocked by Lunos policy/)
        expect(sent.find((line) => line.ran !== undefined)).toEqual({ ran: false, hooked: true })
        expect(readLines(audit)).toContainEqual(
          expect.objectContaining({
            event: "permission.decision",
            permission: "external",
            patterns: ["claude:Bash rm -rf build"],
            decision: "denied by rule",
          }),
        )
        expect(result.stderr).not.toContain("Lunos rules not applied")
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    "a Lunos plugin's pre-tool hook refuses it too, and is audited",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const plugin = path.join(home, "guard-plugin.ts")
        fs.writeFileSync(plugin, GUARD)
        const { log, audit, env } = setup(home, llm.url, { plugin: [pathToFileURL(plugin).href] })
        // The harness runs pure (no plugins); this test needs its plugin loaded.
        const result = yield* opencode.spawn(RUN, { timeoutMs: CHILD_TIMEOUT, env: { ...env, OPENCODE_PURE: "false" } })
        opencode.expectExit(result, 0)
        const sent = readLines(log)
        const hook = sent.find((line) => line.response?.request_id === "hook_toolu_bash").response.response
        expect(hook.hookSpecificOutput.permissionDecisionReason).toBe(
          "Refused by a Lunos plugin hook: rm -rf is not allowed in this project",
        )
        expect(sent.find((line) => line.ran !== undefined)).toEqual({ ran: false, hooked: true })
        expect(readLines(audit)).toContainEqual(
          expect.objectContaining({
            event: "permission.decision",
            patterns: ["claude:Bash rm -rf build"],
            decision: "denied by plugin hook",
          }),
        )
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    "a Claude Code that answers hooks_applied: false gets a warning on stderr",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const { log, env } = setup(home, llm.url, DENY)
        const result = yield* opencode.spawn(RUN, { timeoutMs: CHILD_TIMEOUT, env: { ...env, FAKE_CLAUDE_OLD: "1" } })
        opencode.expectExit(result, 0)
        // The documented gap: this Claude Code ran it without asking anyone.
        expect(readLines(log).find((line) => line.ran !== undefined)).toEqual({ ran: true, hooked: false })
        expect(result.stderr).toContain("Lunos rules not applied")
        expect(result.stderr).toContain("hooks_applied: false")
        expect(result.stdout).not.toContain("hooks_applied")
      }),
    TIMEOUT,
  )
})
