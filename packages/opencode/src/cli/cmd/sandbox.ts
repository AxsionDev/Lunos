import { EOL } from "os"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { writeStdoutEffect } from "../stdout"
import { Sandbox } from "@/sandbox"
import { SandboxConfig } from "@/sandbox/config"

// XCOD-144 slice 1: `--sandbox` on `lunos` and `lunos run`, and `lunos sandbox list|attach|destroy`.
// The host side never loads a project instance for a sandboxed run (that would initialise the
// project's plugins on the host); it creates the container, attaches the normal client to the
// server inside it, and hands the results back when the client is done.

const say = (text: string) => UI.println(UI.Style.TEXT_DIM + "sandbox " + UI.Style.TEXT_NORMAL + text)

/** Whether this invocation runs sandboxed: --sandbox / --no-sandbox, else sandbox.enabled. */
export function wanted(args: { sandbox?: boolean; attach?: string }, directory = process.env.PWD ?? process.cwd()) {
  if (args.sandbox !== undefined) return args.sandbox
  if (args.attach) return false
  return SandboxConfig.load(directory).enabled
}

/** The host's provider credentials, injected into the container's environment at run time. */
async function secrets(): Promise<Record<string, string>> {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Auth } = await import("@/auth")
  const all = await AppRuntime.runPromise(Auth.Service.use((auth) => auth.all())).catch(() => ({}))
  return Object.keys(all).length ? { OPENCODE_AUTH_CONTENT: JSON.stringify(all) } : {}
}

function reportHandoff(result: Sandbox.Handoff) {
  say(
    `results on branch ${UI.Style.TEXT_HIGHLIGHT_BOLD}${result.branch}${UI.Style.TEXT_NORMAL} (${result.commit.slice(0, 12)})`,
  )
  for (const file of result.files) say(`  ${file.status}\t${file.path}`)
  if (result.files.length === 0) say("  no changes")
  say(`transcript and summary in ${result.results}`)
}

/**
 * Hand the results back, then apply the lifecycle policy. Nothing is destroyed unless the handoff
 * succeeded: on failure the container is stopped and kept, and the reason is shown.
 */
async function conclude(info: Sandbox.Meta, conn: Sandbox.Connection, extra: Record<string, unknown>) {
  let result: Sandbox.Handoff
  try {
    result = await Sandbox.handoff(info, conn, extra)
  } catch (error) {
    await Sandbox.SandboxDocker.stop(info.id).catch(() => {})
    UI.error(
      `Couldn't hand the results back, so sandbox ${info.id} was kept (stopped) whatever sandbox.on_finish says: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    say(`inspect it with \`lunos sandbox attach ${info.id}\`, remove it with \`lunos sandbox destroy ${info.id}\``)
    process.exitCode = 1
    return
  }
  reportHandoff(result)
  await Sandbox.finish(info)
  if (info.on_finish === "destroy") say(`destroyed ${info.id} (container and volume)`)
  else
    say(
      `kept ${info.id} (stopped): \`lunos sandbox attach ${info.id}\` reopens it, \`lunos sandbox destroy ${info.id}\` removes it`,
    )
}

/** Create and start a sandbox for `directory`, run `client` against it, then conclude. */
export async function runSandboxed(directory: string, client: (conn: Sandbox.Connection) => Promise<void>) {
  const config = SandboxConfig.load(directory)
  say("starting")
  const info = await Sandbox.create({ directory, config, secrets: await secrets(), log: say })
  say(`${info.id}: image ${info.image.digest ?? info.image.id}, on_finish ${info.on_finish}`)
  let conn: Sandbox.Connection
  try {
    conn = await Sandbox.start(info)
  } catch (error) {
    await Sandbox.SandboxDocker.stop(info.id).catch(() => {})
    say(`kept ${info.id} (stopped) for inspection; \`lunos sandbox destroy ${info.id}\` removes it`)
    throw error
  }
  say(`server ${conn.url}, workspace ${conn.directory}`)
  // Interrupted: there are no results to hand back, so keep the sandbox (stopped) rather than lose it.
  const interrupted = () => {
    say(`interrupted; keeping ${info.id} (stopped): \`lunos sandbox destroy ${info.id}\` removes it`)
    void Sandbox.SandboxDocker.stop(info.id)
      .catch(() => {})
      .finally(() => process.exit(130))
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  const before = process.exitCode
  process.exitCode = undefined
  try {
    await client(conn)
  } finally {
    process.off("SIGINT", interrupted)
    process.off("SIGTERM", interrupted)
    const failed = process.exitCode !== undefined && process.exitCode !== 0
    process.exitCode = failed ? process.exitCode : before
    await conclude(info, conn, { outcome: failed ? "failed" : "succeeded" })
  }
}

/** The TUI, attached to a sandbox's server. */
async function attachTui(conn: Sandbox.Connection, args: { continue?: boolean; session?: string; fork?: boolean }) {
  const { AttachCommand } = await import("./attach")
  await AttachCommand.handler!({
    $0: "lunos",
    _: [],
    url: conn.url,
    dir: conn.directory,
    password: conn.password,
    username: "opencode",
    continue: args.continue,
    session: args.session,
    fork: args.fork,
    mini: false,
  } as never)
}

export async function runSandboxedTui(
  directory: string,
  args: { continue?: boolean; session?: string; fork?: boolean },
) {
  await runSandboxed(directory, (conn) => attachTui(conn, args))
}

export const SandboxListCommand = effectCmd({
  command: "list",
  describe: "list sandboxes, running or kept",
  instance: false,
  handler: Effect.fn("Cli.sandbox.list")(function* () {
    const rows = yield* Effect.tryPromise({ try: () => Sandbox.list(), catch: (error) => error }).pipe(
      Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
    )
    if (rows.length === 0) return yield* writeStdoutEffect(`No sandboxes.${EOL}`)
    const lines = rows.map((row) =>
      [
        row.id,
        row.state.padEnd(8),
        (row.meta?.created ?? row.created).slice(0, 19),
        row.meta?.branch ?? "-",
        row.project ?? "-",
      ].join("  "),
    )
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})

export const SandboxAttachCommand = effectCmd({
  command: "attach <id>",
  describe: "reopen a kept sandbox in the TUI, with its history; the branch advances when you leave",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.sandbox.attach")(function* (args) {
    const info = yield* Effect.tryPromise({ try: () => Sandbox.meta(args.id), catch: (error) => error }).pipe(
      Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
    )
    yield* Effect.promise(async () => {
      const conn = await Sandbox.start(info)
      say(`${info.id}: server ${conn.url}, workspace ${conn.directory}`)
      try {
        await attachTui(conn, { continue: true })
      } finally {
        // A reopened sandbox is kept whatever on_finish says: it was retained to be inspected.
        await conclude({ ...info, on_finish: "retain" }, conn, { outcome: "attached" })
      }
    })
  }),
})

export const SandboxDestroyCommand = effectCmd({
  command: "destroy <id>",
  describe: "remove a sandbox's container and volume",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.sandbox.destroy")(function* (args) {
    yield* Effect.tryPromise({ try: () => Sandbox.destroy(args.id), catch: (error) => error }).pipe(
      Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
    )
    yield* writeStdoutEffect(`Destroyed sandbox ${args.id}.${EOL}`)
  }),
})

export const SandboxCommand = cmd({
  command: "sandbox",
  describe: "manage sandboxes (sandboxed runs: lunos --sandbox, lunos run --sandbox)",
  builder: (yargs) =>
    yargs.command(SandboxListCommand).command(SandboxAttachCommand).command(SandboxDestroyCommand).demandCommand(),
  async handler() {},
})
