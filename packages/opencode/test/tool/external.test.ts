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
  LayerNode.compile(LayerNode.group([Config.node, Truncate.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({ get: () => Effect.succeed({ external: { delegate: true, claude: { path: FAKE } } } as any) }),
    ],
  ] as any),
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
        process.env.FAKE_CLAUDE_LOG = path.join(dir, "..", "fake.log")
        const result = yield* tool.execute({ tool: "claude", task: "Create hello.txt containing hi" }, ctx as any)
        delete process.env.FAKE_CLAUDE_LOG
        expect(asked).toEqual(["claude", "claude:Write", "claude:Write"])
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
