import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { PluginPromise } from "@opencode-ai/core/plugin/promise"
import { ToolHooks } from "@opencode-ai/core/tool-hooks"
import { define as definePromise } from "@opencode-ai/plugin/v2/promise"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const before = () => ({ tool: "bash", sessionID: "ses", callID: "call", args: { command: "a" } })

describe("tool domain (XCOD-75)", () => {
  it.effect("runs Effect and Promise hooks in registration order, each seeing earlier mutations", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* PluginV2.Service)
      const tools = yield* ToolHooks.Service
      const seen: string[] = []

      yield* host.tool["execute.before"]((event) => {
        seen.push(`effect:${event.args.command}`)
        event.args.command += "b"
      })
      yield* PluginPromise.fromPromise(
        definePromise({
          id: "promise-tool",
          setup: async (ctx) => {
            await ctx.tool["execute.before"](async (event) => {
              seen.push(`promise:${event.args.command}`)
              event.args.command += "c"
            })
          },
        }),
      ).effect(host)

      const event = yield* tools.runBefore(before())
      expect(seen).toEqual(["effect:a", "promise:ab"])
      expect(event.args.command).toBe("abc")
    }),
  )

  it.effect("a failing Effect hook aborts and later hooks don't run", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* PluginV2.Service)
      const tools = yield* ToolHooks.Service
      let later = false
      yield* host.tool["execute.before"](() => Effect.fail(new Error("guard said no")))
      yield* host.tool["execute.before"](() => {
        later = true
      })
      const exit = yield* Effect.exit(tools.runBefore(before()))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(later).toBe(false)
    }),
  )

  it.effect("a rejecting Promise hook aborts too", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* PluginV2.Service)
      const tools = yield* ToolHooks.Service
      yield* PluginPromise.fromPromise(
        definePromise({
          id: "promise-guard",
          setup: async (ctx) => {
            await ctx.tool["execute.before"](async () => {
              throw new Error("promise guard said no")
            })
          },
        }),
      ).effect(host)
      const exit = yield* Effect.exit(tools.runBefore(before()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("execute.after hooks can rewrite the output", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* PluginV2.Service)
      const tools = yield* ToolHooks.Service
      yield* host.tool["execute.after"]((event) => {
        event.output.output = event.output.output.toUpperCase()
      })
      const event = yield* tools.runAfter({
        tool: "bash",
        sessionID: "ses",
        callID: "call",
        args: {},
        output: { title: "t", output: "done", metadata: {} },
      })
      expect(event.output.output).toBe("DONE")
    }),
  )

  it.effect("a disposed registration stops firing", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* PluginV2.Service)
      const tools = yield* ToolHooks.Service
      let calls = 0
      const registration = yield* host.tool["execute.before"](() => {
        calls++
      })
      yield* tools.runBefore(before())
      yield* registration.dispose
      yield* tools.runBefore(before())
      expect(calls).toBe(1)
    }),
  )
})
