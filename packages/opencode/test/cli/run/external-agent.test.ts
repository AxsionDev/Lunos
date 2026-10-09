// XCOD-204: a full `lunos run` where the model hands a task to Claude Code with external_agent.
// The scripted LLM makes the tool call; the fake claude (fixtures/fake-claude.ts) replays the
// recorded Claude Code session. Covers the real permission service, the tool registry gate, the
// result the agent gets back, and the audit/residency gates.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

const FAKE = path.join(import.meta.dir, "..", "..", "external", "fixtures", "fake-claude.ts")
const FAKE_CODEX = path.join(import.meta.dir, "..", "..", "external", "fixtures", "fake-codex.ts")
const TIMEOUT = 120_000
// Each run starts lunos plus the fake claude several times (version, help, auth, session); on
// Windows CI that alone can pass the harness's 30 s default child timeout.
const CHILD_TIMEOUT = 90_000

const config = (llmUrl: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...testProviderConfig(llmUrl),
    external: { delegate: true, claude: { path: FAKE }, codex: { path: FAKE_CODEX } },
    // Lunos's own rule for the delegation and for Claude Code's approvals, as a user would set it.
    permission: { external: "allow" },
    ...extra,
  })

describe("lunos run with external_agent (XCOD-204)", () => {
  cliIt.concurrent(
    "the agent delegates to Claude Code and gets back the answer, changed files and cost",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        spawnSync("git", ["init", "-q"], { cwd: home })
        yield* llm.tool("external_agent", { tool: "claude", task: "Create hello.txt containing hi" })
        yield* llm.text("delegated")
        const result = yield* opencode.run("hand it to claude", {
          timeoutMs: CHILD_TIMEOUT,
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url) },
        })
        opencode.expectExit(result, 0)
        expect(fs.readFileSync(path.join(home, "hello.txt"), "utf8")).toBe("hi")
        const inputs = yield* llm.inputs
        const toolResult = JSON.stringify(inputs.at(-1))
        expect(toolResult).toContain("Files changed: hello.txt")
        expect(toolResult).toContain("Cost: $")
        expect(toolResult).toContain("a6fd116c-92e4-4731-a522-99679ab93931")
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    "the agent delegates to Codex the same way, and gets back the answer, changed files and tokens",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        spawnSync("git", ["init", "-q"], { cwd: home })
        yield* llm.tool("external_agent", { tool: "codex", task: "Create note.txt containing from codex" })
        yield* llm.text("delegated")
        const result = yield* opencode.run("hand it to codex", {
          timeoutMs: CHILD_TIMEOUT,
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url) },
        })
        opencode.expectExit(result, 0)
        expect(fs.readFileSync(path.join(home, "note.txt"), "utf8")).toBe("from codex")
        const toolResult = JSON.stringify((yield* llm.inputs).at(-1))
        expect(toolResult).toContain("Files changed: note.txt")
        expect(toolResult).toContain("tokens (Codex CLI reports tokens, not money)")
        expect(toolResult).toContain("lunos external resume codex")
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    "under lunos run, an approval nobody can answer is refused, not silently allowed",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        spawnSync("git", ["init", "-q"], { cwd: home })
        yield* llm.tool("external_agent", { tool: "claude", task: "Create hello.txt containing hi" })
        yield* llm.text("done")
        const result = yield* opencode.run("hand it to claude", {
          timeoutMs: CHILD_TIMEOUT,
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url, { permission: {} }) },
        })
        expect(fs.existsSync(path.join(home, "hello.txt"))).toBe(false)
        expect(result.stdout + result.stderr).toMatch(/auto-rejecting|external/)
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    "the tool isn't offered unless external.delegate is on",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("ok")
        const result = yield* opencode.run("hi", { timeoutMs: CHILD_TIMEOUT })
        opencode.expectExit(result, 0)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[0])).not.toContain("external_agent")
      }),
    TIMEOUT,
  )
})
