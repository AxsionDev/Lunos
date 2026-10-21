import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { spawnSync } from "child_process"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ExternalAgentTool, changed, diff } from "../../src/tool/external"
import { SessionID, MessageID } from "../../src/session/schema"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Session } from "@/session/session"
import { Plugin } from "@/plugin"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Audit } from "@opencode-ai/core/audit"
import { AuditLog } from "@/audit/log"

const FAKE = path.join(import.meta.dir, "..", "external", "fixtures", "fake-claude.ts")
const asked: string[] = []
const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  // The first Claude Code approval is refused in Lunos, everything else allowed.
  ask: (input: { patterns: string[] }) => {
    asked.push(input.patterns.join(","))
    return asked.filter((item) => item.startsWith("claude:")).length === 1 && input.patterns[0].startsWith("claude:")
      ? Effect.fail(new Error("refused"))
      : Effect.void
  },
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Config.node,
      Truncate.node,
      Agent.node,
      Session.node,
      SessionProjector.node,
      Plugin.node,
      Database.node,
    ]),
    [
      [
        Config.node,
        TestConfig.layer({
          get: () => Effect.succeed({ external: { delegate: true, claude: { path: FAKE } } } as any),
        }),
      ],
    ] as any,
  ),
)

describe("tool.external_agent (XCOD-204)", () => {
  it.instance(
    "delegates to Claude Code: approvals go through Lunos, and the result, changed files and cost come back",
    () =>
      Effect.gen(function* () {
        const dir = yield* InstanceState.directory
        spawnSync("git", ["init", "-q"], { cwd: dir })
        const info = yield* ExternalAgentTool
        const tool = yield* info.init()
        const session = yield* Session.Service.use((sessions) => sessions.create({}))
        process.env.FAKE_CLAUDE_LOG = path.join(dir, "..", "fake.log")
        const result = yield* tool.execute({ tool: "claude", task: "Create hello.txt containing hi" }, {
          ...ctx,
          sessionID: session.id,
        } as any)
        delete process.env.FAKE_CLAUDE_LOG
        expect(asked.map((item) => item.replace(/ .*\//, " …/"))).toEqual([
          "claude",
          "claude:Write …/hello.txt",
          "claude:Write …/hello.txt",
        ])
        expect(result.output).toContain("Files changed: hello.txt")
        expect(result.output).toContain("Cost: $")
        expect(result.output).toContain("Refused by the user: Write")
        expect(result.metadata).toMatchObject({
          session: "a6fd116c-92e4-4731-a522-99679ab93931",
          files: ["hello.txt"],
          ok: true,
        })
        expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "hello.txt"), "utf8"))).toBe("hi")
      }),
  )
})

/** What the fake Claude Code logged: the host's messages to it, and whether the call ran. */
const fakeLog = async (file: string) =>
  (await fs.readFile(file, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

/** Runs `rm -rf build` through Claude Code in a mode that allows it without asking, under a deny rule. */
const runDenied = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* InstanceState.directory
    const log = path.join(dir, "..", `fake-${Math.random().toString(36).slice(2)}.log`)
    const audit = path.join(dir, "..", `audit-${Math.random().toString(36).slice(2)}.log`)
    AuditLog.activate({ enabled: true, file: audit, redact: [] })
    const session = yield* Session.Service.use((sessions) =>
      sessions.create({
        permission: [
          { permission: "external", pattern: "*", action: "allow" },
          { permission: "external", pattern: "claude:Bash rm -rf*", action: "deny" },
        ],
      }),
    )
    const tool = yield* (yield* ExternalAgentTool).init()
    Object.assign(process.env, {
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_BASH: "rm -rf build",
      FAKE_CLAUDE_AUTO_ALLOW: "1",
      ...env,
    })
    const asks: string[] = []
    const result = yield* tool
      .execute({ tool: "claude", task: "Clean the build" }, {
        ...ctx,
        sessionID: session.id,
        ask: (input: { patterns: string[] }) => Effect.sync(() => void asks.push(input.patterns.join(","))),
      } as any)
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const key of ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_BASH", "FAKE_CLAUDE_AUTO_ALLOW", ...Object.keys(env)])
              delete process.env[key]
          }),
        ),
      )
    yield* Effect.promise(() => Audit.flush())
    AuditLog.activate({ enabled: false, file: audit, redact: [] })
    return {
      result,
      asks,
      sent: yield* Effect.promise(() => fakeLog(log)),
      audited: yield* Effect.promise(() => fakeLog(audit)),
      sessionID: session.id,
    }
  })

describe("tool.external_agent: Lunos policy on calls Claude Code allows by itself (XCOD-293)", () => {
  it.instance(
    "a Lunos deny rule refuses an auto-allowed call through Claude Code's PreToolUse hook, and is audited",
    () =>
      Effect.gen(function* () {
        const { result, asks, sent, audited, sessionID } = yield* runDenied({})
        // The Lunos policy hook is registered, and it refused the call before the tool's mode allowed it.
        const init = sent.find((line) => line.request?.subtype === "initialize")
        expect(init.request.hooks).toEqual({ PreToolUse: [{ hookCallbackIds: ["lunos-policy"] }] })
        const hook = sent.find((line) => line.response?.request_id === "hook_toolu_bash").response.response
        expect(hook.hookSpecificOutput.permissionDecision).toBe("deny")
        expect(hook.hookSpecificOutput.permissionDecisionReason).toMatch(/^Blocked by Lunos policy/)
        expect(sent.find((line) => line.ran !== undefined)).toEqual({ ran: false, hooked: true })
        // Only the delegation itself was asked about: the tool never asked about the call.
        expect(asks).toEqual(["claude"])
        expect(audited).toContainEqual(
          expect.objectContaining({
            event: "permission.decision",
            session: sessionID,
            permission: "external",
            patterns: ["claude:Bash rm -rf build"],
            decision: "denied by rule",
          }),
        )
        expect(result.output).not.toContain("Lunos rules not applied")
      }),
  )

  it.instance("a Claude Code that answers hooks_applied: false: the result warns the Lunos rules weren't applied", () =>
    Effect.gen(function* () {
      const { result, sent } = yield* runDenied({ FAKE_CLAUDE_OLD: "1" })
      // The documented gap: this Claude Code ran it without asking anyone.
      expect(sent.find((line) => line.ran !== undefined)).toEqual({ ran: true, hooked: false })
      expect(result.output).toContain("Warning: Lunos rules not applied.")
      expect(result.output).toContain("hooks_applied: false")
      expect(result.metadata).toMatchObject({ hooksApplied: false })
    }),
  )
})

describe("changed files (XCOD-204)", () => {
  it.instance("diff lists files whose git status changed, and nothing outside a repository", () =>
    Effect.gen(function* () {
      expect(
        diff(
          new Map([["a", " M"]]),
          new Map([
            ["a", " M"],
            ["b", "??"],
          ]),
        ),
      ).toEqual(["b"])
      expect(changed("/")).toEqual(new Map())
    }),
  )
})
