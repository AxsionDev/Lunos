import { EOL } from "os"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { writeStdoutEffect } from "../stdout"
import { Sandbox } from "@/sandbox"
import { SandboxConfig } from "@/sandbox/config"
import { AuditLog } from "@/audit/log"

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
 * is then refused by `refuseHost`, before anything starts.
 */
export function wanted(args: { sandbox?: boolean; attach?: string }, directory = process.env.PWD ?? process.cwd()) {
  if (args.attach) return args.sandbox === true
  const config = SandboxConfig.load(directory)
  if (config.required) return true
  if (args.sandbox !== undefined) return args.sandbox
  return config.enabled
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

/** Create and start a sandbox for `directory`, run `client` against it, then conclude. */
export async function runSandboxed(
  directory: string,
  client: (conn: Sandbox.Connection) => Promise<void>,
  lifecycle: Lifecycle = {},
) {
  const override = lifecycleOverride(lifecycle)
  const loaded = SandboxConfig.load(directory)
  const config = { ...loaded, on_finish: override ?? loaded.on_finish }
  await hostAudit()
  await pruneExpired()
  say("starting")
  const stored = await credentials()
  const info = await Sandbox.create({ directory, config, providers: Object.keys(stored), log: say })
  const policy = info.on_finish
  say(`${info.id}: image ${info.image.digest ?? info.image.id}, on_finish ${policy}`)
  let conn: Sandbox.Connection
  try {
    conn = await Sandbox.start(info, { secrets: secrets(stored) })
  } catch (error) {
    await Sandbox.retain(info, "start failed")
    say(`kept ${info.id} (stopped) for inspection; \`lunos sandbox destroy ${info.id}\` removes it`)
    throw error
  }
  say(`server ${conn.url}, workspace ${conn.directory}`)
  // Interrupted: there are no results to hand back, so keep the sandbox (stopped) rather than lose it.
  const interrupted = () => {
    say(`interrupted; keeping ${info.id} (stopped): \`lunos sandbox destroy ${info.id}\` removes it`)
    void Sandbox.retain(info, "interrupted")
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
    process.off("SIGINT", interrupted)
    process.off("SIGTERM", interrupted)
    const failed = process.exitCode !== undefined && process.exitCode !== 0
    process.exitCode = failed ? process.exitCode : before
    await conclude(info, conn, { failed, label: failed ? "failed" : "finished" }, policy)
  }
}

/** Remove expired retained sandboxes, saying which. Never fails the command it runs in. */
export async function pruneExpired() {
  const removed = await Sandbox.prune().catch((error) => {
    say(`couldn't prune expired sandboxes: ${error instanceof Error ? error.message : String(error)}`)
    return [] as string[]
  })
  for (const id of removed) say(`pruned ${id} (retain_for expired)`)
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

export async function runSandboxedTui(
  directory: string,
  args: { continue?: boolean; session?: string; fork?: boolean } & Lifecycle,
) {
  await runSandboxed(directory, (conn) => attachTui(conn, args), args)
}

/** Every `lunos sandbox` subcommand runs these first. */
const prepare = Effect.promise(async () => {
  await hostAudit()
  await pruneExpired()
})

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
  )

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
      .command(SandboxEgressCommand)
      .demandCommand(),
  async handler() {},
})
