import { Effect, Exit, Schema } from "effect"
import { spawnSync } from "node:child_process"
import * as Tool from "./tool"
import DESCRIPTION from "./external.txt"
import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import { ExternalDetect } from "@/external/detect"
import { ExternalPolicy } from "@/external/policy"
import { ExternalClaude } from "@/external/claude"
import { ExternalRegistry } from "@/external/registry"
import { ExternalRun } from "@/external/run"
import { EffectBridge } from "@/effect/bridge"

// XCOD-204: delegation to the user's own Claude Code or Codex CLI. Registered only with `external.delegate`.
// Each approval the tool asks for becomes a Lunos permission request ("external", pattern
// "claude:<Tool>"), so it shows in Lunos's own approval UI and follows the user's rules.

export const Parameters = Schema.Struct({
  tool: Schema.Literals(["claude", "codex"]).annotate({
    description: "Which tool to delegate to: claude (Claude Code) or codex (Codex CLI)",
  }),
  task: Schema.String.annotate({ description: "The task, written so it can be done without this conversation" }),
})

/** Paths `git status` reports as changed (staged, unstaged or untracked). Empty outside a repository. */
export function changed(cwd: string) {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" })
  if (result.status !== 0) return new Map<string, string>()
  return new Map(
    result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(3).replace(/^.* -> /, ""), line.slice(0, 2)] as const),
  )
}

/** Files whose status differs after the run: the ones Claude Code changed (or reverted). */
export function diff(before: Map<string, string>, after: Map<string, string>) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file)).sort()
}

export const ExternalAgentTool = Tool.define(
  "external_agent",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const instance = yield* InstanceState.context
          const cwd = instance.directory
          ExternalPolicy.check(params.tool, cfg)
          const status = yield* Effect.promise(() =>
            ExternalDetect.detect(params.tool, ExternalRun.configuredPath(params.tool, cfg)),
          )
          if (!status.installed || status.outdated || status.loggedIn === false)
            throw new Error(status.hint ?? `${status.label} isn't usable here`)
          yield* ctx.ask({
            permission: "external",
            patterns: [params.tool],
            always: [params.tool],
            metadata: { tool: params.tool, task: params.task },
          })
          yield* ctx.metadata({ title: `${ExternalDetect.TOOLS[params.tool].label}: ${params.task.slice(0, 60)}` })
          // Claude Code's callbacks run outside this fiber; the bridge keeps its services (permission, session).
          const bridge = yield* EffectBridge.make()
          const before = changed(cwd)
          const title = `${ExternalDetect.TOOLS[params.tool].label}: ${params.task.slice(0, 60)}`
          let last = ""
          const running = ExternalRun.start({
            tool: params.tool,
            cwd,
            prompt: params.task,
            permissionMode: (cfg.external as any)?.[params.tool]?.permission_mode,
            executable: status.path,
            // Progress in the tool part, so the TUI and apps show what Claude Code is doing.
            onEvent: (event) => {
              const step =
                event.type === "tool"
                  ? `→ ${event.name}`
                  : event.type === "text"
                    ? event.text.split("\n").at(-1)
                    : undefined
              if (!step) return
              last = step
              bridge.fork(ctx.metadata({ title, metadata: { progress: last } }))
            },
            ask: async (request) => {
              // The target goes in the pattern, so "always" on claude:Bash covers one command, not all.
              const target = String(request.input.command ?? request.input.file_path ?? request.input.path ?? "*")
              const exit = await bridge.promise(
                Effect.exit(
                  ctx.ask({
                    permission: "external",
                    patterns: [`${params.tool}:${request.tool} ${target}`],
                    always: [`${params.tool}:${request.tool} ${request.tool === "Bash" ? target : "*"}`],
                    metadata: {
                      tool: params.tool,
                      action: request.tool,
                      description: request.description,
                      input: request.input,
                    },
                  }),
                ),
              )
              return Exit.isSuccess(exit)
                ? { allow: true }
                : { allow: false, message: "The user refused this in Lunos." }
            },
          })
          const abort = () => running.stop()
          ctx.abort.addEventListener("abort", abort, { once: true })
          const result = yield* Effect.promise(() => running.done)
          ctx.abort.removeEventListener("abort", abort)
          const files = diff(before, changed(cwd))
          if (result.type === "error") {
            ExternalPolicy.record(cfg, "external.session", {
              tool: params.tool,
              provider: ExternalDetect.TOOLS[params.tool].provider,
              outcome: "error",
              delegated: true,
            })
            throw new Error(result.message)
          }
          ExternalPolicy.record(cfg, "external.session", {
            tool: params.tool,
            provider: ExternalDetect.TOOLS[params.tool].provider,
            session: result.sessionID,
            outcome: result.ok ? "success" : result.subtype,
            cost_usd: result.costUSD,
            turns: result.turns,
            denied: result.denied.length,
            delegated: true,
          })
          yield* Effect.promise(() =>
            ExternalRegistry.save({
              sessionID: result.sessionID,
              tool: params.tool,
              cwd,
              started: new Date().toISOString(),
              updated: new Date().toISOString(),
              status: result.ok ? "done" : "failed",
              costUSD: result.costUSD,
              turns: result.turns,
            }),
          )
          const cost = ExternalRun.cost(params.tool, result)
          return {
            title: `${ExternalDetect.TOOLS[params.tool].label} ${result.ok ? "finished" : result.subtype}`,
            output: [
              result.text || "(no answer)",
              "",
              `Files changed: ${files.length ? files.join(", ") : "none"}`,
              `Cost: ${cost}`,
              `${ExternalDetect.TOOLS[params.tool].label} session: ${result.sessionID} (resume with: lunos external resume ${params.tool} ${result.sessionID} "…")`,
              ...(result.denied.length
                ? [`Refused by the user: ${result.denied.map((item) => item.tool).join(", ")}`]
                : []),
            ].join("\n"),
            metadata: { session: result.sessionID, files, costUSD: result.costUSD, ok: result.ok },
          }
        }),
    }
  }),
)
