import { EOL } from "os"
import { createInterface } from "readline/promises"
import { Effect } from "effect"
import type { Argv } from "yargs"
import { Config } from "@/config/config"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { ExternalDetect } from "@/external/detect"
import { ExternalPolicy } from "@/external/policy"
import { ExternalClaude } from "@/external/claude"
import { ExternalRegistry } from "@/external/registry"

// XCOD-204: `lunos external` drives the user's own Claude Code (and, once wired, Codex CLI).
// Approvals follow `lunos run`'s rule: asked on a terminal, refused when not attached to one
// unless --auto is given. Approval-skipping modes need --permission-mode … --unsafe for the run.

const out = (line: string) => process.stdout.write(line + EOL)

const ListCommand = effectCmd({
  command: "list",
  describe: "show which external coding tools are installed, their versions and login state",
  instance: false,
  handler: Effect.fn("Cli.external.list")(function* () {
    for (const tool of ["claude", "codex"] as const) {
      const status = yield* Effect.promise(() => ExternalDetect.detect(tool))
      const state = !status.installed
        ? "not installed"
        : status.outdated
          ? `${status.version} (too old: ${status.outdated})`
          : `${status.version}, ${status.loggedIn === true ? "logged in" : status.loggedIn === false ? "not logged in" : "login state unknown"}`
      out(`${status.label.padEnd(12)} ${state}`)
      if (status.hint) out(`${" ".repeat(13)}${status.hint}`)
    }
  }),
})

function asker(auto: boolean) {
  return async (request: ExternalClaude.PermissionRequest): Promise<ExternalClaude.PermissionDecision> => {
    const what = `${request.tool}${request.description ? ` (${request.description})` : ""}`
    if (auto) {
      out(UI.Style.TEXT_DIM + `  approved (--auto): ${what}` + UI.Style.TEXT_NORMAL)
      return { allow: true }
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      out(`  permission requested: ${what}; refused (not on a terminal; pass --auto to approve)`)
      return { allow: false, message: "Refused by Lunos: no one is attached to approve it." }
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`  Allow ${what}? ${JSON.stringify(request.input).slice(0, 200)} [y/N] `)).trim()
    rl.close()
    return /^y(es)?$/i.test(answer) ? { allow: true } : { allow: false, message: "Refused in Lunos by the user." }
  }
}

const runBuilder = (yargs: Argv) =>
  yargs
    .positional("tool", { type: "string", choices: ["claude", "codex"], demandOption: true })
    .positional("prompt", {
      type: "string",
      demandOption: true,
      describe: "prompt, or one of the tool's own /commands",
    })
    .option("permission-mode", { type: "string", describe: "the tool's permission mode (default: its safe mode)" })
    .option("unsafe", { type: "boolean", default: false, describe: "allow an approval-skipping mode for this run" })
    .option("auto", { type: "boolean", default: false, describe: "approve every request the tool makes (dangerous!)" })
    .option("max-budget-usd", { type: "number", describe: "stop the tool past this spend" })
    .option("json", { type: "boolean", default: false, describe: "print events as JSON lines" })

function runHandler(resume: boolean) {
  return Effect.fn(resume ? "Cli.external.resume" : "Cli.external.run")(function* (args: any) {
    const tool = args.tool as ExternalDetect.Tool
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const refused = yield* Effect.sync(() => {
      try {
        ExternalPolicy.check(tool, config)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    if (refused) return yield* fail(refused)
    if (tool === "codex")
      return yield* fail("Codex CLI isn't supported yet from `lunos external` (XCOD-204 in progress).")
    const status = yield* Effect.promise(() => ExternalDetect.detect(tool, config.external?.claude?.path))
    if (!status.installed || status.outdated || status.loggedIn === false)
      return yield* fail(status.hint ?? "Claude Code isn't usable")
    const previous = resume ? yield* Effect.promise(() => ExternalRegistry.get(args.session)) : undefined
    if (resume && !previous) out(`No record of ${args.session} in Lunos; resuming it in Claude Code anyway.`)
    const cwd = previous?.cwd ?? process.cwd()
    const started = new Date().toISOString()
    let lastText = ""
    const running = yield* Effect.try({
      try: () =>
        ExternalClaude.start({
          cwd,
          prompt: args.prompt,
          resume: resume ? args.session : undefined,
          permissionMode: args.permissionMode ?? config.external?.claude?.permission_mode,
          allowUnsafe: args.unsafe,
          maxBudgetUSD: args.maxBudgetUsd,
          executable: status.path,
          ask: asker(args.auto),
          onEvent: (event) => {
            if (args.json) return out(JSON.stringify(event))
            if (event.type === "init") {
              out(
                UI.Style.TEXT_DIM +
                  `Claude Code session ${event.sessionID}${event.model ? ` · ${event.model}` : ""}` +
                  UI.Style.TEXT_NORMAL,
              )
              void ExternalRegistry.save({
                sessionID: event.sessionID,
                tool,
                cwd,
                started: previous?.started ?? started,
                updated: new Date().toISOString(),
                status: "running",
                pid: running.child.pid,
              })
            }
            if (event.type === "text") {
              lastText = event.text
              out(event.text)
            }
            if (event.type === "tool") out(UI.Style.TEXT_DIM + `→ ${event.name}` + UI.Style.TEXT_NORMAL)
            if (event.type === "tool_result" && event.isError)
              out(UI.Style.TEXT_DIM + `  ${event.output.slice(0, 300)}` + UI.Style.TEXT_NORMAL)
          },
        }),
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    const result = yield* Effect.promise(() => running.done)
    if (result.type === "error") {
      ExternalPolicy.record(config, "external.session", { tool, provider: "anthropic", outcome: "error" })
      return yield* fail(result.message)
    }
    ExternalPolicy.record(config, "external.session", {
      tool,
      provider: "anthropic",
      session: result.sessionID,
      outcome: result.ok ? "success" : result.subtype,
      cost_usd: result.costUSD,
      turns: result.turns,
      denied: result.denied.length,
      resumed: resume,
    })
    yield* Effect.promise(() =>
      ExternalRegistry.save({
        sessionID: result.sessionID,
        tool,
        cwd,
        started: previous?.started ?? started,
        updated: new Date().toISOString(),
        status: result.ok ? "done" : "failed",
        costUSD: result.costUSD,
        turns: result.turns,
      }),
    )
    if (!args.json) {
      // The result repeats the last message; print it only if it wasn't streamed.
      if (result.text && result.text.trim() !== lastText.trim()) out(result.text)
      out(
        UI.Style.TEXT_DIM +
          `${result.ok ? "done" : result.subtype} · session ${result.sessionID} · ${result.turns ?? "?"} turns` +
          (result.costUSD !== undefined ? ` · $${result.costUSD.toFixed(4)} (as reported by Claude Code)` : "") +
          (result.denied.length ? ` · ${result.denied.length} refused` : "") +
          UI.Style.TEXT_NORMAL,
      )
    }
    if (!result.ok) process.exitCode = 1
  })
}

const RunCommand = effectCmd({
  command: "run <tool> <prompt>",
  describe: "start a session in Claude Code (or Codex) with your own install and login",
  builder: runBuilder,
  handler: runHandler(false),
})

const ResumeCommand = effectCmd({
  command: "resume <tool> <session> <prompt>",
  describe: "continue an external session by its id",
  builder: (yargs) => runBuilder(yargs).positional("session", { type: "string", demandOption: true }),
  handler: runHandler(true),
})

const SessionsCommand = effectCmd({
  command: "sessions",
  describe: "list the external sessions Lunos started",
  instance: false,
  handler: Effect.fn("Cli.external.sessions")(function* () {
    const list = yield* Effect.promise(() => ExternalRegistry.list())
    if (!list.length) return out("No external sessions yet.")
    for (const item of list)
      out(
        `${item.sessionID}  ${ExternalDetect.TOOLS[item.tool].label.padEnd(11)} ${item.status.padEnd(8)} ${item.updated.slice(0, 16)}  ${item.cwd}` +
          (item.costUSD !== undefined ? `  $${item.costUSD.toFixed(4)}` : ""),
      )
  }),
})

const StopCommand = effectCmd({
  command: "stop <session>",
  describe: "stop a running external session",
  instance: false,
  builder: (yargs) => yargs.positional("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.external.stop")(function* (args) {
    const result = yield* Effect.promise(() => ExternalRegistry.stop(String(args.session)))
    if (!result.ok) return yield* fail(result.reason)
    out(`Stopped ${args.session}`)
  }),
})

export const ExternalCommand = cmd({
  command: "external",
  describe: "drive Claude Code and Codex CLI from Lunos with your own installs",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(RunCommand)
      .command(ResumeCommand)
      .command(SessionsCommand)
      .command(StopCommand)
      .demandCommand(),
  handler: () => {},
})
