import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import * as prompts from "@clack/prompts"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionBulk } from "@/session/bulk"
import { SessionOverview } from "@/session/overview"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionStopCommand)
      .command(SessionArchiveCommand)
      .command(SessionUnarchiveCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    // XCOD-265: sessions cleared from /sessions (archived) aren't listed; `lunos session unarchive` brings them back.
    const sessions = (yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))).filter(
      (session) => !session.time.archived,
    )

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

/** XCOD-265: "7d", "12h", "30m", "2w" to milliseconds; undefined when it isn't one. */
export function parseAge(value: string) {
  const match = /^(\d+)\s*([mhdw])$/.exec(value.trim())
  if (!match) return undefined
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m" | "h" | "d" | "w"]
  return Number(match[1]) * unit
}

/** Asks on a terminal; elsewhere (a script, a pipe) only --yes goes ahead. */
const confirmed = Effect.fn("Cli.session.confirm")(function* (message: string, yes: boolean | undefined) {
  if (yes) return true
  if (!process.stdin.isTTY) return yield* fail(`${message} Pass --yes to go ahead without asking.`)
  const ok = yield* Effect.promise(() => prompts.confirm({ message }))
  if (prompts.isCancel(ok) || ok !== true) {
    UI.println("Cancelled; nothing was changed.")
    return false
  }
  return true
})

const failures = (failed: SessionBulk.Failure[]) => {
  for (const item of failed) UI.println(`  ${item.id}: ${item.reason}`)
}

export const SessionStopCommand = effectCmd({
  command: "stop",
  describe: "stop every running or waiting session on this computer (as Stop all in /sessions)",
  builder: (yargs) =>
    yargs
      .option("all", { describe: "stop all of them (required)", type: "boolean", demandOption: true })
      .option("project", { describe: "only sessions of the project in this directory", type: "boolean" })
      .option("yes", { alias: "y", describe: "don't ask for confirmation", type: "boolean" }),
  handler: Effect.fn("Cli.session.stop")(function* (args) {
    if (!args.all) return yield* fail("Pass --all to stop every running or waiting session.")
    const ctx = yield* InstanceRef
    const overview = yield* SessionOverview.build()
    const targets = overview.sessions.filter(
      (item) => SessionBulk.stoppable(item) && (!args.project || item.project?.id === ctx?.project.id),
    )
    if (targets.length === 0) {
      UI.println("Nothing is running or waiting.")
      return
    }
    const elsewhere = targets.filter((item) => item.elsewhere).length
    const message = `Stop ${targets.length} ${targets.length === 1 ? "session" : "sessions"}?${elsewhere ? ` ${elsewhere} of them run in another Lunos window.` : ""}`
    if (!(yield* confirmed(message, args.yes))) return
    const result = yield* SessionBulk.stop({
      sessionIDs: targets.map((item) => item.id),
      reason: "Stopped by lunos session stop",
    })
    UI.println(
      `Stopped ${result.stopped.length}${result.failed.length ? ` · ${result.failed.length} couldn't be stopped` : ""}`,
    )
    failures(result.failed)
    if (result.failed.length) process.exitCode = 1
  }),
})

export const SessionArchiveCommand = effectCmd({
  command: "archive",
  describe: "clear finished sessions from the lists (archived: hidden, not deleted)",
  builder: (yargs) =>
    yargs
      .option("finished", {
        describe: "archive every session that isn't running or waiting (required)",
        type: "boolean",
        demandOption: true,
      })
      .option("older-than", { describe: "only those last active before this, e.g. 7d, 12h, 2w", type: "string" })
      .option("yes", { alias: "y", describe: "don't ask for confirmation", type: "boolean" }),
  handler: Effect.fn("Cli.session.archive")(function* (args) {
    if (!args.finished) return yield* fail("Pass --finished to archive the sessions that aren't running.")
    const age = args.olderThan === undefined ? undefined : parseAge(args.olderThan)
    if (args.olderThan !== undefined && age === undefined)
      return yield* fail(`--older-than takes a number and a unit (m, h, d, w), e.g. 7d; not "${args.olderThan}".`)
    const ids = yield* SessionBulk.finished({ before: age === undefined ? undefined : Date.now() - age })
    if (ids.length === 0) {
      UI.println("Nothing to archive.")
      return
    }
    const message = `Archive ${ids.length} finished ${ids.length === 1 ? "session" : "sessions"}? They're hidden from the lists, not deleted.`
    if (!(yield* confirmed(message, args.yes))) return
    const result = yield* SessionBulk.archive({ sessionIDs: ids })
    UI.println(
      `Archived ${result.archived.length}${result.skipped.length ? ` · ${result.skipped.length} skipped` : ""}. Bring them back with: lunos session unarchive --all`,
    )
    failures(result.skipped)
  }),
})

export const SessionUnarchiveCommand = effectCmd({
  command: "unarchive [sessionID]",
  describe: "put archived sessions back in the lists",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { describe: "the archived session to restore", type: "string" })
      .option("all", { describe: "restore every archived session", type: "boolean" })
      .option("yes", { alias: "y", describe: "don't ask for confirmation", type: "boolean" }),
  handler: Effect.fn("Cli.session.unarchive")(function* (args) {
    if (!args.sessionID === !args.all) return yield* fail("Give a session id or --all (not both).")
    const ids = args.all ? yield* SessionBulk.archived() : [args.sessionID!]
    if (ids.length === 0) {
      UI.println("Nothing is archived.")
      return
    }
    const message = `Restore ${ids.length} archived ${ids.length === 1 ? "session" : "sessions"} to the lists?`
    if (!(yield* confirmed(message, args.yes))) return
    const result = yield* SessionBulk.unarchive({ sessionIDs: ids })
    UI.println(
      `Restored ${result.archived.length}${result.skipped.length ? ` · ${result.skipped.length} skipped` : ""}`,
    )
    failures(result.skipped)
    if (result.skipped.length) process.exitCode = 1
  }),
})
