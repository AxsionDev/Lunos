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
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import * as prompts from "@clack/prompts"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionBulk } from "@/session/bulk"
import { SessionOverview } from "@/session/overview"
import { SessionShare } from "@/share/session"

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

/**
 * XCOD-284: which sessions `lunos session delete --archived` reaches: archived top-level sessions
 * (and Claude Code / Codex rows), last active before `before`, in the project at `project` (a path).
 */
export function archivedTargets<
  T extends Pick<SessionOverview.Item, "id" | "parentID" | "updated" | "directory"> & {
    project?: { worktree: string }
  },
>(items: readonly T[], input: { before?: number; project?: string }) {
  const inside = (dir: string | undefined, root: string) =>
    !!dir && (dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
  return items.filter(
    (item) =>
      !item.parentID &&
      (input.before === undefined || item.updated < input.before) &&
      (input.project === undefined ||
        inside(item.project?.worktree, input.project) ||
        inside(item.directory, input.project)),
  )
}

export const SessionDeleteCommand = effectCmd({
  command: "delete [sessionIDs..]",
  describe: "delete sessions for good: their history, subagent sessions and queued prompts",
  builder: (yargs) =>
    yargs
      .positional("sessionIDs", { describe: "the sessions to delete", type: "string", array: true })
      .option("archived", { describe: "delete every archived session (see lunos session archive)", type: "boolean" })
      .option("older-than", {
        describe: "with --archived: only those last active before this, e.g. 30d, 12h, 2w",
        type: "string",
      })
      .option("project", { describe: "with --archived: only sessions of the project at this path", type: "string" })
      .option("stop", {
        describe: "stop running or waiting sessions first (otherwise they're skipped)",
        type: "boolean",
      })
      .option("keep-cloud", { describe: "keep the synced copies on Lunos Cloud", type: "boolean" })
      .option("keep-shares", {
        describe: "leave the console shares made from them (lunos share) live",
        type: "boolean",
      })
      .option("yes", { alias: "y", describe: "don't ask for confirmation", type: "boolean" }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const given = (args.sessionIDs ?? []).map(String).filter(Boolean)
    if (given.length > 0 === !!args.archived) return yield* fail("Give session ids or --archived (not both).")
    if (!args.archived && (args.olderThan !== undefined || args.project !== undefined))
      return yield* fail("--older-than and --project go with --archived.")
    const age = args.olderThan === undefined ? undefined : parseAge(args.olderThan)
    if (args.olderThan !== undefined && age === undefined)
      return yield* fail(`--older-than takes a number and a unit (m, h, d, w), e.g. 30d; not "${args.olderThan}".`)

    const svc = yield* Session.Service
    const ids = args.archived
      ? archivedTargets((yield* SessionOverview.build({ archived: true })).sessions, {
          before: age === undefined ? undefined : Date.now() - age,
          project: args.project === undefined ? undefined : path.resolve(args.project),
        }).map((item) => item.id)
      : given
    if (ids.length === 0) {
      UI.println(args.archived ? "No archived sessions match; nothing was deleted." : "Nothing to delete.")
      return
    }
    // Titles, for the summary (a Claude Code / Codex row is named by its id).
    const titles = new Map<string, string>()
    for (const id of ids) {
      if (id.startsWith(SessionBulk.EXTERNAL_PREFIX)) continue
      const info = yield* svc.get(SessionID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (info) titles.set(id, info.title)
    }
    const name = (id: string) => (titles.has(id) ? `${id}  ${Locale.truncate(titles.get(id)!, 50)}` : id)

    const count = `${ids.length} ${ids.length === 1 ? "session" : "sessions"}`
    const message = `Delete ${count} for good? Their history, subagent sessions and queued prompts go; files in your projects stay.${args.keepCloud ? "" : " Synced copies on Lunos Cloud are deleted too (--keep-cloud keeps them)."}`
    // Ids given in a script (no terminal) delete as before, without asking; --archived needs --yes there.
    const ask = args.archived || process.stdin.isTTY
    if (ask) {
      // The console shares made from them (lunos share): revoked first, unless --keep-shares.
      const preview = yield* SessionBulk.preview({ sessionIDs: ids })
      const shares = preview.items.flatMap((item) =>
        (item.consoleShares ?? []).map((share) => ({ ...share, of: item.id })),
      )
      if (shares.length) {
        UI.println(
          `${args.keepShares ? "Left live (--keep-shares)" : "Revoked first"}: ${shares.length === 1 ? "1 console share" : `${shares.length} console shares`} made from them on ${preview.console ?? "your organisation's console"}:`,
        )
        for (const share of shares)
          UI.println(`  ${share.id}${share.url ? `  ${share.url}` : ""}  (from ${name(share.of)})`)
      }
      if (preview.console) UI.println(SessionBulk.UNLINKED_SHARES_NOTE)
      if (!(yield* confirmed(message, args.yes))) return
    }

    const share = yield* SessionShare.Service
    const result = yield* SessionBulk.remove({
      sessionIDs: ids,
      archivedOnly: !!args.archived,
      stop: !!args.stop,
      keepCloud: !!args.keepCloud,
      keepShares: !!args.keepShares,
      origin: "cli",
      reason: "Stopped by lunos session delete",
      unshare: share.unshare,
    })
    // One id that doesn't exist reads as it always has.
    if (ids.length === 1 && result.skipped[0]?.reason === "no such session")
      return yield* fail(`Session not found: ${ids[0]}`)
    const stopped = result.stopped?.length ? ` (stopped ${result.stopped.length} first)` : ""
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD +
        `Deleted ${result.deleted.length}${stopped}${result.skipped.length ? ` · ${result.skipped.length} skipped` : ""}` +
        UI.Style.TEXT_NORMAL,
    )
    for (const id of result.deleted) UI.println(`  deleted ${name(id)}`)
    for (const id of result.sharesRevoked ?? []) UI.println(`  revoked console share ${id}`)
    for (const item of result.skipped) UI.println(`  skipped ${name(item.id)}: ${item.reason}`)
    if (result.skipped.length) process.exitCode = 1
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
