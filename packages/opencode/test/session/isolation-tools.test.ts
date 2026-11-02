import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Plugin } from "../../src/plugin"
import { SessionID, MessageID } from "../../src/session/schema"
import { SubagentIsolation } from "../../src/session/isolation"
import { isolated } from "../../src/session/tools"
import { EditTool } from "../../src/tool/edit"
import { ShellTool } from "../../src/tool/shell"
import { WriteTool } from "../../src/tool/write"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        LSP.node,
        EventV2Bridge.node,
        Format.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const sessionID = SessionID.make("ses_isolated-subagent")
const ctx = {
  sessionID,
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "general",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("XCOD-332 tools of a session bound to a worktree", () => {
  it.live("write, edit and shell run in the worktree; the user's tree stays as it was", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), "one\n"))
      yield* Effect.promise(() => SubagentIsolation.git(["add", "-A"], { cwd: dir }))
      yield* Effect.promise(() => SubagentIsolation.git(["commit", "-qm", "a"], { cwd: dir }))
      const data = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "lunos-iso-data-")))
      const root = yield* Effect.promise(() => SubagentIsolation.toplevel(dir))
      const created = yield* Effect.promise(() =>
        SubagentIsolation.create({ root, dataDir: data, session: "ses_tools", step: "tools" }),
      )
      const wt = created.handle.directory
      SubagentIsolation.bind(sessionID, {
        handle: created.handle,
        from: { root: dir, directory: dir },
        to: { root: wt, directory: wt },
      })

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const write = yield* (yield* WriteTool).init()
          const edit = yield* (yield* EditTool).init()
          const shell = yield* (yield* ShellTool).init()
          // An absolute path in the user's tree, as the orchestrator's prompt would name it.
          yield* isolated("write", sessionID, { filePath: path.join(dir, "b.txt"), content: "new\n" }, (args) =>
            write.execute(args as never, ctx),
          )
          yield* isolated("edit", sessionID, { filePath: "a.txt", oldString: "one", newString: "two" }, (args) =>
            edit.execute(args as never, ctx),
          )
          yield* isolated(
            "bash",
            sessionID,
            { command: `echo ran > ${path.join(dir, "c.txt")} && pwd > where.txt`, description: "write" },
            (args) => shell.execute(args as never, ctx),
          )
          // Not a worktree tool: the instance is the user's.
          const seen = yield* isolated("question", sessionID, {}, () => InstanceState.context)
          expect(seen.directory).toBe(dir)
        }),
      )

      expect(yield* Effect.promise(() => Bun.file(path.join(wt, "b.txt")).text())).toBe("new\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(wt, "a.txt")).text())).toBe("two\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(wt, "c.txt")).text())).toBe("ran\n")
      expect((yield* Effect.promise(() => Bun.file(path.join(wt, "where.txt")).text())).trim()).toBe(
        yield* Effect.promise(() => fs.realpath(wt)),
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "b.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "c.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("one\n")

      // Merged back, the user's tree has all three; the worktree and branch are gone.
      yield* Effect.promise(() => SubagentIsolation.finalize(created.handle))
      const merged = yield* Effect.promise(() => SubagentIsolation.merge(created.handle))
      expect(merged.state).toBe("merged")
      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("two\n")
      SubagentIsolation.unbind(sessionID)
      yield* Effect.promise(() => SubagentIsolation.discard(created.handle))
      yield* Effect.promise(() => fs.rm(data, { recursive: true, force: true }))
      const branches = yield* Effect.promise(() =>
        SubagentIsolation.git(["for-each-ref", "refs/heads/lunos/"], { cwd: dir }),
      )
      expect(branches.stdout.trim()).toBe("")
    }),
  )
})
