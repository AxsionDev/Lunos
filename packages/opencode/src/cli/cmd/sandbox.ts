import { EOL } from "os"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { writeStdoutEffect } from "../stdout"
import { Sandbox } from "@/sandbox"
import { SandboxConfig } from "@/sandbox/config"
import { SandboxError, SandboxFailure } from "@/sandbox/error"
import { SandboxPreflight } from "@/sandbox/preflight"
import { SandboxRollback } from "@/sandbox/rollback"
import { SandboxDisabled } from "@/sandbox/disabled"
import { SandboxBackground } from "@/sandbox/background"
import { SandboxGit } from "@/sandbox/git"
import type { SandboxFailure as SandboxFailureInfo, SandboxHost, SandboxState } from "@opencode-ai/tui/util/sandbox"
import { AuditLog } from "@/audit/log"
import { RunEnding } from "./run/ending"
import { Failure } from "../failure"
import { RunLog } from "@opencode-ai/core/observability/run-log"

// XCOD-144 slice 1: `--sandbox` on `lunos` and `lunos run`, and `lunos sandbox list|attach|destroy`.
// The host side never loads a project instance for a sandboxed run (that would initialise the
// project's plugins on the host); it creates the container, attaches the normal client to the
// server inside it, and hands the results back when the client is done.
//
// XCOD-157: --keep / --rm, destroy_on_success, retain_for, and `sandbox prune|logs|stop`. The host
// has no project instance, so nothing else activates its audit trail: `hostAudit` does, from global
// and managed config, before any sandbox event is emitted.

const say = (text: string) => UI.println(UI.Style.TEXT_DIM + "sandbox " + UI.Style.TEXT_NORMAL + text)

/**
 * Whether this invocation runs sandboxed: --sandbox / --no-sandbox, else sandbox.enabled. With
 * sandbox.required it always does (--attach excepted: that client runs nothing here); --no-sandbox
 * is then refused by `refuseHost`, before anything starts. XCOD-281: sandbox.enabled doesn't count
 * while the sandbox is turned off after a failure here (`SandboxDisabled`); --sandbox tries again.
 */
export function wanted(args: { sandbox?: boolean; attach?: string }, directory = process.env.PWD ?? process.cwd()) {
  if (args.attach) return args.sandbox === true
  const config = SandboxConfig.load(directory)
  if (config.required) return true
  if (args.sandbox !== undefined) return args.sandbox
  return config.enabled && !SandboxDisabled.get(directory, config)
}

/** XCOD-281: `--sandbox=strict`: a sandbox that can't start fails the run instead of running without it. */
export function strictArg(argv: readonly string[] = process.argv) {
  return argv.includes("--sandbox=strict")
}

/**
 * The refusal for running `what` on the host under sandbox.required, recorded in the audit trail,
 * or undefined when it may run. `--no-sandbox` under a requirement is refused the same way.
 */
export async function refuseHost(what: string, directory = process.env.PWD ?? process.cwd()) {
  const config = SandboxConfig.load(directory)
  const message = SandboxConfig.refusal(config, what)
  if (!message) return undefined
  await hostAudit()
  AuditLog.emit("sandbox.refused", { what, reason: "sandbox.required", by: config.requiredBy })
  return message
}

/** Per-run lifecycle overrides: --keep retains, --rm destroys, whatever sandbox.on_finish says. */
export type Lifecycle = { keep?: boolean; rm?: boolean }

export function lifecycleOverride(args: Lifecycle): Sandbox.Meta["on_finish"] | undefined {
  if (args.keep && args.rm) throw new Error("--keep and --rm contradict each other; pass one")
  if (args.keep) return "retain"
  if (args.rm) return "destroy"
  return undefined
}

let audited = false

/** Activate the host's audit trail for sandbox events. Idempotent; the host never loads config otherwise. */
export async function hostAudit() {
  if (audited) return
  audited = true
  const settings = AuditLog.resolve(
    SandboxConfig.auditConfig(SandboxConfig.globalDoc(), await SandboxConfig.managedDoc()) as Parameters<
      typeof AuditLog.resolve
    >[0],
  )
  AuditLog.activate(settings)
}

/** The host's stored provider credentials: injected into the container at run time. */
async function credentials(): Promise<Record<string, unknown>> {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Auth } = await import("@/auth")
  return AppRuntime.runPromise(Auth.Service.use((auth) => auth.all())).catch(() => ({}))
}

const secrets = (all: Record<string, unknown>): Record<string, string> =>
  Object.keys(all).length ? { OPENCODE_AUTH_CONTENT: JSON.stringify(all) } : {}

function reportHandoff(result: Sandbox.Handoff) {
  if (result.mode === "branch")
    say(
      `results on branch ${UI.Style.TEXT_HIGHLIGHT_BOLD}${result.branch}${UI.Style.TEXT_NORMAL} (${result.commit?.slice(0, 12)})`,
    )
  if (result.mode === "patch")
    say(`the agent's changes are in ${UI.Style.TEXT_HIGHLIGHT_BOLD}${result.patch}${UI.Style.TEXT_NORMAL} (git apply)`)
  if (result.mode !== "none") {
    for (const file of result.files) say(`  ${file.status}\t${file.path}`)
    if (result.files.length === 0) say("  no changes")
  } else if (result.workspace === "mount") say("the agent's changes are already in your working tree (workspace mount)")
  else say('changes not handed back (sandbox.results is "none")')
  say(`transcript and summary in ${result.results}`)
}

/**
 * Hand the results back, then apply the lifecycle policy. Nothing is destroyed unless the handoff
 * succeeded: on failure the container is stopped and kept, and the reason is shown.
 */
async function conclude(
  info: Sandbox.Meta,
  conn: Sandbox.Connection,
  outcome: { failed: boolean; label: string },
  policy = info.on_finish,
) {
  let result: Sandbox.Handoff
  try {
    result = await Sandbox.handoff(info, conn, { outcome: outcome.label })
  } catch (error) {
    await Sandbox.retain(info, "handoff failed")
    UI.error(
      `Couldn't hand the results back, so sandbox ${info.id} was kept (stopped) whatever sandbox.on_finish says: ` +
        (error instanceof Error ? error.message : String(error)),
    )
    say(`inspect it with \`lunos sandbox attach ${info.id}\`, remove it with \`lunos sandbox destroy ${info.id}\``)
    process.exitCode = 1
    return
  }
  reportHandoff(result)
  const refused = (await Sandbox.collectEgress(info)).filter((item) => !item.allowed)
  if (refused.length) {
    const hosts = [...new Set(refused.map((item) => `${item.host}:${item.port}`))]
    say(`network ${info.network}: refused ${refused.length} connection(s) to ${hosts.join(", ")}`)
  }
  const failed = outcome.failed || result.failed
  const done = await Sandbox.finish(info, { failed, commit: result.commit, files: result.files.length }, policy)
  if (done === "destroyed") say(`destroyed ${info.id} (container and volumes)`)
  else
    say(
      `kept ${info.id} (stopped${failed && policy === "destroy_on_success" ? ", because the task failed" : ""}` +
        `${info.expires ? `, until ${info.expires}` : ""}): ` +
        `\`lunos sandbox attach ${info.id}\` reopens it, \`lunos sandbox destroy ${info.id}\` removes it`,
    )
}

/**
 * Create and start a sandbox for `directory`. XCOD-279: anything that goes wrong here is a
 * SandboxError naming its step; nothing has run in the sandbox yet, so a caller can still start
 * without it.
 */
async function launch(
  directory: string,
  lifecycle: Lifecycle,
  options: { log?: (line: string) => void; created?: (info: Sandbox.Meta) => void } = {},
) {
  const log = options.log ?? say
  const { info, stored } = await SandboxFailure.at("create", async () => {
    const override = lifecycleOverride(lifecycle)
    const loaded = SandboxConfig.load(directory)
    const config = { ...loaded, on_finish: override ?? loaded.on_finish }
    await hostAudit()
    await pruneExpired(log)
    log("starting")
    const stored = await credentials()
    const info = await Sandbox.create({ directory, config, providers: Object.keys(stored), log })
    return { info, stored }
  })
  options.created?.(info)
  log(`${info.id}: image ${info.image.digest ?? info.image.id}, on_finish ${info.on_finish}`)
  try {
    const conn = await Sandbox.start(info, { secrets: secrets(stored) })
    return { info, conn }
  } catch (error) {
    await Sandbox.retain(info, "start failed").catch(() => {})
    log(`kept ${info.id} (stopped) for inspection; \`lunos sandbox destroy ${info.id}\` removes it`)
    throw SandboxFailure.wrap("start", error)
  }
}

/**
 * Create and start a sandbox for `directory`, run `client` against it, then conclude. XCOD-281: when
 * it can't start and `host` is given, say so in one line and run `host` instead, unless the
 * sandbox is required or `strict` (`--sandbox=strict`): then the error stands.
 */
export async function runSandboxed(
  directory: string,
  client: (conn: Sandbox.Connection) => Promise<void>,
  lifecycle: Lifecycle = {},
  options: { strict?: boolean; host?: () => Promise<void> } = {},
) {
  lifecycleOverride(lifecycle)
  let started: Awaited<ReturnType<typeof launch>>
  try {
    started = await launch(directory, lifecycle)
  } catch (error) {
    const wrapped = SandboxFailure.wrap("create", error)
    if (!options.host || options.strict || SandboxConfig.load(directory).required) throw wrapped
    // Recovered (the run goes on), so in the log without the failure footer.
    RunLog.note("the sandbox couldn't start; running without it", RunLog.describe(wrapped))
    const log = RunLog.current()
    UI.println(
      UI.Style.TEXT_WARNING_BOLD + "!",
      UI.Style.TEXT_NORMAL,
      `sandbox failed, running without it: ${wrapped.fix ?? wrapped.reason}${log ? ` · log: ${log.file}` : ""}`,
    )
    return options.host()
  }
  await session(started.info, started.conn, client)
}

/** Run `client` against a started sandbox, then hand the results back and apply the lifecycle policy. */
async function session(
  info: Sandbox.Meta,
  conn: Sandbox.Connection,
  client: (conn: Sandbox.Connection) => Promise<void>,
) {
  const policy = info.on_finish
  say(`server ${conn.url}, workspace ${conn.directory}`)
  // Interrupted: there are no results to hand back, so keep the sandbox (stopped) rather than lose it.
  let stopping: Promise<unknown> | undefined
  const interrupted = () => {
    RunEnding.interrupted = true
    say(`interrupted; keeping ${info.id} (stopped): \`lunos sandbox destroy ${info.id}\` removes it`)
    stopping = Sandbox.retain(info, "interrupted")
      .catch(() => {})
      .then(() => Promise.race([AuditLog.flush(), Bun.sleep(3000)]))
      .finally(() => process.exit(130))
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  const before = process.exitCode
  process.exitCode = undefined
  try {
    await client(conn)
  } finally {
    // The stopped container closes the client's connection; that's not a result to hand back.
    if (stopping) await stopping
    process.off("SIGINT", interrupted)
    process.off("SIGTERM", interrupted)
    const failed = process.exitCode !== undefined && process.exitCode !== 0
    process.exitCode = failed ? process.exitCode : before
    await conclude(info, conn, { failed, label: failed ? "failed" : "finished" }, policy)
  }
}

/** Remove expired retained sandboxes, saying which. Never fails the command it runs in. */
export async function pruneExpired(log = say) {
  const removed = await Sandbox.prune().catch((error) => {
    log(`couldn't prune expired sandboxes: ${error instanceof Error ? error.message : String(error)}`)
    return [] as string[]
  })
  for (const id of removed) log(`pruned ${id} (retain_for expired)`)
  return removed
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

/** XCOD-281: a sandbox failure as the user sees it, with the run log that has the full error. */
export function failureInfo(error: SandboxError, directory: string): SandboxFailureInfo {
  const config = SandboxConfig.load(directory)
  const log = RunLog.current()
  return {
    reason: error.reason,
    ...(error.fix ? { fix: error.fix } : {}),
    time: new Date().toISOString(),
    ...(log ? { log } : {}),
    ...(config.required ? { requiredBy: config.requiredBy ?? "config" } : {}),
  }
}

/**
 * XCOD-281 (replaces XCOD-279's "Start without the sandbox?" question): a sandbox that couldn't
 * start behind the TUI. The full error goes to the run log. Under sandbox.required: "blocked", and
 * nothing runs until Retry works. Otherwise the sandbox change a /restart was made for is undone
 * (XCOD-279), the sandbox is turned off for this project through local state (no config file is
 * written), and "failed": Lunos starts again without it.
 */
export function failed(
  error: unknown,
  directory: string,
  changes: readonly SandboxRollback.Change[] = [],
): SandboxState {
  const wrapped = SandboxFailure.wrap("create", error)
  RunLog.failure("sandbox", wrapped)
  const failure = failureInfo(wrapped, directory)
  if (failure.requiredBy) return { status: "blocked", failure }
  const undone = SandboxRollback.revert(changes.filter((change) => change.path[0] === "sandbox"))
  if (undone.length) {
    RunLog.note("the sandbox couldn't start; the change was undone", undone.join(", "))
    failure.reason += ` (your change to ${undone.map((key) => `\`${key}\``).join(", ")} was undone)`
  }
  if (SandboxConfig.load(directory).enabled) SandboxDisabled.set(directory, failure)
  return { status: "failed", failure }
}

/**
 * XCOD-281: whether the TUI starts with the sandbox. A relaunch after it failed doesn't (unless it's
 * required); a Retry does; otherwise `wanted`.
 */
export function startsSandboxed(
  args: { sandbox?: boolean },
  directory: string,
  handoff?: { failed?: SandboxFailureInfo; retry?: boolean },
) {
  if (SandboxConfig.load(directory).required) return true
  if (handoff?.failed) return false
  if (handoff?.retry) return true
  return wanted(args, directory)
}

/**
 * XCOD-281: Lunos on this computer while the sandbox is turned off after a failure: what the TUI
 * shows for it (the "no sandbox" badge, and right after the failure the toast). Undefined when the
 * sandbox simply isn't on.
 */
export function sandboxOff(
  directory: string,
  handoff?: { failed?: SandboxFailureInfo },
  queued?: boolean,
): SandboxHost | undefined {
  const failure = handoff?.failed ?? SandboxDisabled.get(directory)
  if (!failure) return undefined
  const state: SandboxState = { status: "off", failure, announce: Boolean(handoff?.failed), queued }
  return {
    state: () => state,
    subscribe: () => () => {},
    retry: () => {},
    reenable: () => SandboxDisabled.clear(directory),
    doctor: () => doctor(directory),
  }
}

/** `lunos sandbox doctor`'s checks, as it prints them. */
export async function doctor(directory: string) {
  const checks = await SandboxPreflight.run({ directory, full: true })
  return checks.flatMap(checkLines).join(EOL)
}

/**
 * XCOD-281: the TUI with the sandbox starting behind it. Returns the TUI's transport, which waits
 * for the sandbox (see `SandboxBackground`), the directory the TUI works in (the workspace inside
 * the container, known before the container exists), and `finish`, which hands the results back
 * when the TUI is done. No worker, server, plugin, MCP or LSP server starts on this computer.
 */
export async function sandboxTui(
  directory: string,
  args: Lifecycle,
  restarted?: { changes?: SandboxRollback.Change[] },
) {
  // A wrong pair of flags isn't the sandbox failing to start: refused before anything, with no way round it.
  try {
    lifecycleOverride(args)
  } catch (error) {
    throw new SandboxError({ reason: SandboxFailure.describe(error) })
  }
  const workdir = await SandboxGit.repo(directory)
    .then((repo) => Sandbox.workdirOf(repo.relative))
    .catch(() => undefined)
  let info: Sandbox.Meta | undefined
  const background = SandboxBackground.start({
    async launch(progress) {
      const started = await launch(directory, args, {
        // The TUI covers the terminal: the steps go to the run log and the status line.
        log: (line) => {
          RunLog.note("sandbox", line)
          progress(line)
        },
        created: (meta) => (info = meta),
      })
      return started.conn
    },
    ready() {
      SandboxDisabled.clear(directory)
      return { status: "ready", id: info?.id ?? "" }
    },
    failed: (error) => failed(error, directory, restarted?.changes ?? []),
    reenable: () => SandboxDisabled.clear(directory),
    doctor: () => doctor(directory),
  })

  // Interrupted from outside (the TUI takes Ctrl+C itself): keep the sandbox (stopped) rather than lose it.
  const interrupted = () => {
    RunEnding.interrupted = true
    void (info ? Sandbox.retain(info, "interrupted").catch(() => {}) : Promise.resolve())
      .then(() => Promise.race([AuditLog.flush(), Bun.sleep(3000)]))
      .finally(() => process.exit(130))
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)

  return {
    fetch: background.fetch,
    host: background.host,
    directory: workdir ?? directory,
    /** Once the TUI has exited: hand the results back, or keep a sandbox that was still starting. */
    async finish() {
      process.off("SIGINT", interrupted)
      process.off("SIGTERM", interrupted)
      const conn = background.connection()
      if (conn && info) {
        say(`server ${conn.url}, workspace ${conn.directory}`)
        const unsuccessful = process.exitCode !== undefined && process.exitCode !== 0
        await conclude(info, conn, { failed: unsuccessful, label: unsuccessful ? "failed" : "finished" })
        return
      }
      const state = background.host.state()
      if (state.status === "starting" && info) {
        await Sandbox.retain(info, "interrupted").catch(() => {})
        say(`left while it was starting; kept ${info.id} (stopped): \`lunos sandbox destroy ${info.id}\` removes it`)
      }
    },
  }
}

/** Every `lunos sandbox` subcommand runs these first. */
const prepare = Effect.promise(async () => {
  await hostAudit()
  await pruneExpired()
})

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) => {
      // XCOD-280: the stack and cause go to the run log before the message becomes a CliError.
      Failure.record("sandbox", error)
      return fail(SandboxFailure.describe(error))
    }),
  )

/** XCOD-279: one check as `lunos sandbox doctor` prints it, with the command and output when it failed. */
export function checkLines(check: SandboxPreflight.Check) {
  const mark = { pass: "pass", fail: "FAIL", skip: "skip" }[check.status]
  return [
    `${mark}  ${check.name}: ${check.detail}`,
    ...(check.status === "fail" && check.error?.command ? [`        command: ${check.error.command}`] : []),
    ...(check.status === "fail" && check.error?.code !== undefined ? [`        exit code: ${check.error.code}`] : []),
    ...(check.status === "fail" && check.error?.stderr
      ? check.error.stderr.split("\n").map((line) => `        | ${line}`)
      : []),
    ...(check.fix ? [`      fix: ${check.fix}`] : []),
  ]
}

export const SandboxDoctorCommand = effectCmd({
  command: "doctor",
  describe: "check that a sandbox can start here: each check, pass or fail, with a fix",
  instance: false,
  handler: Effect.fn("Cli.sandbox.doctor")(function* () {
    const checks = yield* attempt(() =>
      SandboxPreflight.run({ directory: process.env.PWD ?? process.cwd(), full: true }),
    )
    yield* writeStdoutEffect(checks.flatMap(checkLines).join(EOL) + EOL)
    const failed = checks.filter((check) => check.status === "fail").length
    if (failed)
      return yield* fail(
        `${failed} check${failed === 1 ? "" : "s"} failed: a sandbox can't start here until ${failed === 1 ? "it's" : "they're"} fixed. ` +
          "`lunos --no-sandbox` starts Lunos without one.",
      )
    yield* writeStdoutEffect(`A sandbox can start here.${EOL}`)
  }),
})

export const SandboxListCommand = effectCmd({
  command: "list",
  describe: "list sandboxes, running or kept",
  instance: false,
  handler: Effect.fn("Cli.sandbox.list")(function* () {
    yield* prepare
    const rows = yield* attempt(() => Sandbox.list())
    if (rows.length === 0) return yield* writeStdoutEffect(`No sandboxes.${EOL}`)
    const lines = rows.map((row) =>
      [
        row.id,
        row.state.padEnd(8),
        (row.meta?.created ?? row.created).slice(0, 19),
        row.meta?.expires ? `expires ${row.meta.expires.slice(0, 16)}` : "-",
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
    yield* prepare
    const info = yield* attempt(() => Sandbox.meta(args.id))
    yield* Effect.promise(async () => {
      // Reopened, it no longer expires on the old schedule; leaving it again sets a new one.
      info.expires = undefined
      const conn = await Sandbox.start(info, { secrets: secrets(await credentials()), attach: true })
      say(`${info.id}: server ${conn.url}, workspace ${conn.directory}`)
      try {
        await attachTui(conn, { continue: true })
      } finally {
        // A reopened sandbox is kept whatever on_finish says: it was retained to be inspected.
        await conclude(info, conn, { failed: false, label: "attached" }, "retain")
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
    yield* prepare
    yield* attempt(() => Sandbox.destroy(args.id))
    yield* writeStdoutEffect(`Destroyed sandbox ${args.id}.${EOL}`)
  }),
})

export const SandboxPruneCommand = effectCmd({
  command: "prune",
  describe: "remove kept sandboxes whose sandbox.retain_for has expired (also runs at every start)",
  instance: false,
  handler: Effect.fn("Cli.sandbox.prune")(function* () {
    yield* Effect.promise(() => hostAudit())
    const removed = yield* attempt(() => Sandbox.prune())
    yield* writeStdoutEffect(
      removed.length ? `Pruned ${removed.join(", ")}.${EOL}` : `Nothing to prune: no kept sandbox has expired.${EOL}`,
    )
  }),
})

export const SandboxLogsCommand = effectCmd({
  command: "logs <id>",
  describe: "show a sandbox server's log",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("follow", { alias: "f", type: "boolean", describe: "keep streaming until the sandbox stops" })
      .option("tail", { type: "number", describe: "only the last N lines" }),
  handler: Effect.fn("Cli.sandbox.logs")(function* (args) {
    yield* attempt(() => Sandbox.meta(args.id))
    const code = yield* attempt(() =>
      Sandbox.SandboxDocker.streamLogs(args.id, { tail: args.tail, follow: args.follow }),
    )
    if (code !== 0) return yield* fail(`docker logs exited with ${code}`)
  }),
})

export const SandboxStopCommand = effectCmd({
  command: "stop <id>",
  describe: "stop a running sandbox and keep it (no results are handed back; attach does that)",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.sandbox.stop")(function* (args) {
    yield* prepare
    const info = yield* attempt(() => Sandbox.meta(args.id))
    yield* attempt(() => Sandbox.retain(info, "stopped"))
    yield* writeStdoutEffect(`Stopped sandbox ${args.id}; it is kept.${EOL}`)
  }),
})

/** Run by the egress container (see src/sandbox/egress.ts); not for people. */
export const SandboxEgressCommand = cmd({
  command: "egress",
  describe: false,
  async handler() {
    const { SandboxEgress } = await import("@/sandbox/egress")
    const [host, port] = (process.env.LUNOS_EGRESS_UPSTREAM ?? "sandbox:4096").split(":")
    SandboxEgress.serve({
      allow: JSON.parse(process.env.LUNOS_EGRESS_ALLOW ?? "[]") as string[],
      mode: process.env.LUNOS_EGRESS_MODE,
      upstream: { host, port: Number(port) },
    })
    // PID 1 in its container: without a handler, `docker stop` waits out its timeout.
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve)
      process.once("SIGINT", resolve)
    })
  },
})

export const SandboxCommand = cmd({
  command: "sandbox",
  describe: "manage sandboxes (sandboxed runs: lunos --sandbox, lunos run --sandbox)",
  builder: (yargs) =>
    yargs
      .command(SandboxListCommand)
      .command(SandboxAttachCommand)
      .command(SandboxLogsCommand)
      .command(SandboxStopCommand)
      .command(SandboxDestroyCommand)
      .command(SandboxPruneCommand)
      .command(SandboxDoctorCommand)
      .command(SandboxEgressCommand)
      .demandCommand(),
  async handler() {},
})
