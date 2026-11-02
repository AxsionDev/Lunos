import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit } from "effect"
import path from "path"
import { SubagentIsolation } from "@/session/isolation"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
    ],
  }
}


const git = (cwd: string, ...args: string[]) => Effect.promise(() => SubagentIsolation.git(args, { cwd }))
const read = (file: string) => Effect.promise(() => Bun.file(file).text().catch(() => undefined))

/** A repository with `src/a.ts` committed, as the user's tree. */
const setup = Effect.fn("TaskIsolationTest.setup")(function* () {
  const test = yield* TestInstance
  yield* Effect.promise(() => Bun.write(path.join(test.directory, "src/a.ts"), "export const a = 1\n"))
  yield* git(test.directory, "add", "-A")
  yield* git(test.directory, "commit", "-qm", "a")
  return test.directory
})

const lunosBranches = (dir: string) =>
  git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/lunos/").pipe(
    Effect.map((out) => out.stdout.split("\n").filter(Boolean)),
  )

const call = (promptOps: TaskPromptOps, chat: { id: SessionID }, assistant: { id: MessageID }) =>
  Effect.gen(function* () {
    const def = yield* (yield* TaskTool).init()
    return yield* def
      .execute(
        { description: "add feature", prompt: "do it", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      .pipe(Effect.exit)
  })

/** Ops whose subagent "edits" through its binding, as its tools would. */
function ops(handlers: Record<string, (input: SessionPrompt.PromptInput, binding: SubagentIsolation.Binding | undefined) => Promise<{ text?: string; error?: boolean }>>): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.promise(async () => {
        const handler = handlers[input.agent ?? "general"]
        const out = handler ? await handler(input, SubagentIsolation.lookup(input.sessionID)) : {}
        return reply(
          input,
          out.text ?? "done",
          out.error ? new SessionV1.APIError({ message: "boom", isRetryable: false }).toObject() : undefined,
        )
      }),
  }
}

describe("tool.task worktree isolation (XCOD-332)", () => {
  it.instance(
    "a writing subagent edits its own worktree; its work is merged into the user's tree and the worktree removed",
    () =>
      Effect.gen(function* () {
        const dir = yield* setup()
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        let during: string | undefined
        const exit = yield* call(
          ops({
            general: async (input, binding) => {
              if (!binding) throw new Error("expected a worktree")
              expect(input.parts.some((part) => part.type === "text" && part.text.includes("isolated git worktree"))).toBe(true)
              await Bun.write(path.join(binding.to.root, "src/b.ts"), "export const b = 2\n")
              during = await Bun.file(path.join(dir, "src/b.ts")).text().catch(() => undefined)
              return { text: "added b" }
            },
          }),
          chat,
          assistant,
        )
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
        expect(during).toBeUndefined()
        expect(yield* read(path.join(dir, "src/b.ts"))).toBe("export const b = 2\n")
        expect(exit.value.output).toContain("<isolation")
        expect(exit.value.output).toContain("Run the qa checks")
        expect(yield* lunosBranches(dir)).toEqual([])
        const child = (yield* sessions.children(chat.id))[0]!
        expect((child.metadata as { isolation?: { state?: string } }).isolation?.state).toBe("merged")
      }),
    { git: true },
  )

  it.instance(
    "a failed subagent leaves no partial edits in the user's tree",
    () =>
      Effect.gen(function* () {
        const dir = yield* setup()
        const { chat, assistant } = yield* seed()
        const exit = yield* call(
          ops({
            general: async (_, binding) => {
              await Bun.write(path.join(binding!.to.root, "src/a.ts"), "half-made")
              await Bun.write(path.join(binding!.to.root, "src/c.ts"), "half-made")
              return { error: true }
            },
          }),
          chat,
          assistant,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* read(path.join(dir, "src/a.ts"))).toBe("export const a = 1\n")
        expect(yield* read(path.join(dir, "src/c.ts"))).toBeUndefined()
        expect((yield* git(dir, "status", "--porcelain")).stdout.trim()).toBe("")
        expect(yield* lunosBranches(dir)).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "a real conflict goes to the merge subagent, which resolves it in the worktree",
    () =>
      Effect.gen(function* () {
        const dir = yield* setup()
        const { chat, assistant } = yield* seed()
        const seen: string[] = []
        const exit = yield* call(
          ops({
            general: async (_, binding) => {
              await Bun.write(path.join(binding!.to.root, "src/a.ts"), "export const a = 2\n")
              // Meanwhile the user (or another subagent) changed the same line.
              await Bun.write(path.join(dir, "src/a.ts"), "export const a = 3\n")
              return {}
            },
            merge: async (input, binding) => {
              seen.push(input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"))
              const text = await Bun.file(path.join(binding!.to.root, "src/a.ts")).text()
              expect(text).toContain("<<<<<<<")
              await Bun.write(path.join(binding!.to.root, "src/a.ts"), "export const a = 2 + 3\n")
              return { text: "src/a.ts: kept both" }
            },
          }),
          chat,
          assistant,
        )
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
        expect(seen[0]).toContain("export const a = 3")
        expect(seen[0]).toContain("export const a = 2")
        expect(yield* read(path.join(dir, "src/a.ts"))).toBe("export const a = 2 + 3\n")
        expect(yield* lunosBranches(dir)).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "when the merge subagent fails and nobody can be asked, nothing is merged and the conflict is reported",
    () =>
      Effect.gen(function* () {
        const dir = yield* setup()
        const { chat, assistant } = yield* seed()
        const exit = yield* call(
          ops({
            general: async (_, binding) => {
              await Bun.write(path.join(binding!.to.root, "src/a.ts"), "export const a = 2\n")
              await Bun.write(path.join(binding!.to.root, "src/other.ts"), "export const other = 1\n")
              await Bun.write(path.join(dir, "src/a.ts"), "export const a = 3\n")
              return {}
            },
            merge: async () => ({ error: true }),
          }),
          chat,
          assistant,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("unreachable")
        const failure = Cause.squash(exit.cause) as Error
        expect(failure.message).toContain("Merge conflict in src/a.ts")
        const patch = failure.message.match(/saved in (.+\.patch)/)?.[1]
        expect(yield* read(patch!)).toContain("export const a = 2")
        expect(yield* read(path.join(dir, "src/a.ts"))).toBe("export const a = 3\n")
        expect(yield* read(path.join(dir, "src/other.ts"))).toBeUndefined()
        expect(yield* lunosBranches(dir)).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    'subagent.isolation "shared" keeps today\'s behaviour',
    () =>
      Effect.gen(function* () {
        const dir = yield* setup()
        const { chat, assistant } = yield* seed()
        const exit = yield* call(
          ops({
            general: async (_, binding) => {
              expect(binding).toBeUndefined()
              await Bun.write(path.join(dir, "src/b.ts"), "shared\n")
              return {}
            },
          }),
          chat,
          assistant,
        )
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
        expect(exit.value.output).not.toContain("<isolation")
        expect(yield* read(path.join(dir, "src/b.ts"))).toBe("shared\n")
      }),
    { git: true, config: { subagent: { isolation: "shared" } } },
  )

  it.instance("outside a git repository, subagents share the folder as before", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { chat, assistant } = yield* seed()
      const exit = yield* call(
        ops({
          general: async (_, binding) => {
            expect(binding).toBeUndefined()
            await Bun.write(path.join(test.directory, "b.txt"), "shared\n")
            return {}
          },
        }),
        chat,
        assistant,
      )
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
      expect(yield* read(path.join(test.directory, "b.txt"))).toBe("shared\n")
    }),
  )
})
