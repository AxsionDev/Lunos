import { EOL } from "os"
import { spawn as spawnProcess } from "node:child_process"
import { rmSync } from "node:fs"
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
import { SandboxEffective } from "@/sandbox/effective"
import { SandboxBackground } from "@/sandbox/background"
import { SandboxGit } from "@/sandbox/git"
import { SandboxConclude } from "@/sandbox/conclude"
import { Restart } from "../restart"
import type {
  SandboxFailure as SandboxFailureInfo,
  SandboxHandback,
  SandboxHost,
  SandboxSaved,
  SandboxState,
} from "@opencode-ai/tui/util/sandbox"
import { AuditLog } from "@/audit/log"
import { RunEnding } from "./run/ending"
import { Failure } from "../failure"
import { RunLog } from "@opencode-ai/core/observability/run-log"
import { StartupTrace } from "@opencode-ai/core/startup-trace"

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
 * XCOD-297: the same answer /settings and `lunos sandbox status` give (`SandboxEffective`).
 */
export function wanted(args: { sandbox?: boolean; attach?: string }, directory = process.env.PWD ?? process.cwd()) {
  if (args.attach) return args.sandbox === true
  const state = SandboxEffective.resolve(directory)
  if (state.config.required) return true
  if (args.sandbox !== undefined) return args.sandbox
  return state.on
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

/** What came back, as lines (printed with the "sandbox" prefix). */
export function reportLines(result: Sandbox.Handoff) {
  const lines: string[] = []
  // XCOD-301: nothing changed: there was nothing to copy out, and no branch was made.
  if (result.unchanged) lines.push("no changes in the workspace, so nothing was handed back")
  // XCOD-282: nothing is written into a plain folder until you ask.
  const folder = result.source === "folder" && result.mode !== "none" && !result.unchanged
  if (folder)
    lines.push(
      `results kept for ${result.root} (not a git repository): ` +
        `${UI.Style.TEXT_HIGHLIGHT_BOLD}lunos sandbox apply ${result.id}${UI.Style.TEXT_NORMAL} writes them into it`,
    )
  else if (result.mode === "branch" && !result.unchanged)
    lines.push(
      `results on branch ${UI.Style.TEXT_HIGHLIGHT_BOLD}${result.branch}${UI.Style.TEXT_NORMAL} (${result.commit?.slice(0, 12)})`,
    )
  if (result.mode === "patch" && !result.unchanged)
    lines.push(
      `${folder ? "also " : ""}the agent's changes are in ${UI.Style.TEXT_HIGHLIGHT_BOLD}${result.patch}${UI.Style.TEXT_NORMAL} (git apply)`,
    )
  if (result.mode !== "none" && !result.unchanged) {
    for (const file of result.files) lines.push(`  ${file.status}\t${file.path}`)
    if (result.files.length === 0) lines.push("  no changes")
  } else if (result.mode === "none" && result.workspace === "mount")
    lines.push("the agent's changes are already in your working tree (workspace mount)")
  else if (result.mode === "none") lines.push('changes not handed back (sandbox.results is "none")')
  lines.push(`transcript and summary in ${result.results}`)
  return lines
}

/** The handoff step's detail: "3 files, 1 commit", "skipped: no changes". */
function handoffDetail(result: Sandbox.Handoff) {
  if (result.unchanged) return "skipped: no changes"
  if (result.mode === "none") return "transcript only"
  const files = `${result.files.length} file${result.files.length === 1 ? "" : "s"}`
  return result.files.length && result.commit ? `${files}, 1 commit` : files
}

type Outcome = { failed: boolean; label: string }

/** The server of a sandbox the helper concludes: still running (the usual case), or started again (Retry). */
async function reconnect(info: Sandbox.Meta) {
  if (await Sandbox.SandboxDocker.running(info.id)) {
    const conn = Sandbox.connection(info, await Sandbox.SandboxDocker.hostPort(info.id))
    const ok = await fetch(`${conn.url}/global/health`, { headers: conn.headers, signal: AbortSignal.timeout(5000) })
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return conn
  }
  return Sandbox.start(info, { secrets: secrets(await credentials()) })
}

/**
 * XCOD-301: hand the results back, then apply the lifecycle policy, writing each step to the
 * helper's state file (`lunos sandbox status <id>`). Nothing is destroyed unless the handoff
 * succeeded: on failure the container is stopped and kept, the error goes to the run log, and the
 * next start in the project says so. What used to run in the foreground when Lunos exited.
 */
export async function concludeWork(info: Sandbox.Meta, outcome: Outcome, policy = info.on_finish) {
  const previous = SandboxConclude.read(info.id)
  const state: SandboxConclude.State = {
    id: info.id,
    root: info.root,
    state: "running",
    pid: process.pid,
    started: previous?.state === "running" ? previous.started : new Date().toISOString(),
    steps: [],
    lines: [],
    ...(RunLog.current() ? { log: RunLog.current() } : {}),
    input: { ...outcome, policy },
  }
  const save = () => {
    try {
      SandboxConclude.write(state)
    } catch {}
  }
  save()
  const step = async <T>(label: string, run: () => Promise<T>, detail?: (value: T) => string | undefined) => {
    const item: SandboxConclude.Step = { label, started: new Date().toISOString() }
    state.steps.push(item)
    save()
    const value = await run()
    item.finished = new Date().toISOString()
    item.detail = detail?.(value)
    save()
    return value
  }

  let result: Sandbox.Handoff
  try {
    const conn = await step("Connecting to the sandbox", () => reconnect(info))
    const same = await step(
      "Checking for changes",
      () => Sandbox.unchanged(info),
      (value) => (value ? "none" : undefined),
    )
    if (same) RunLog.note("sandbox", `${info.id}: handoff skipped: no changes`)
    result = await step(
      same ? "Saving the transcript" : "Handing back results",
      () => Sandbox.handoff(info, conn, { outcome: outcome.label }, { unchanged: same }),
      handoffDetail,
    )
  } catch (error) {
    await Sandbox.retain(info, "handoff failed").catch(() => {})
    RunLog.failure("sandbox", error, { headline: `Couldn't hand the results of sandbox ${info.id} back` })
    state.state = "failed"
    state.finished = new Date().toISOString()
    state.reason = SandboxFailure.describe(error)
    state.outcome = "retained"
    state.lines.push(
      `kept ${info.id} (stopped) whatever sandbox.on_finish says: \`lunos sandbox conclude ${info.id}\` tries again, ` +
        `\`lunos sandbox attach ${info.id}\` reopens it, \`lunos sandbox destroy ${info.id}\` removes it`,
    )
    save()
    return state
  }
  state.lines.push(...reportLines(result))
  // Only a policy can refuse anything; collectEgress reads only what's new since the last time.
  if (info.network && info.network !== "open") {
    const refused = await step(
      "Reading the network log",
      async () => (await Sandbox.collectEgress(info)).filter((item) => !item.allowed),
      (items) => (items.length ? `${items.length} refused` : "nothing refused"),
    ).catch(() => [])
    if (refused.length) {
      const hosts = [...new Set(refused.map((item) => `${item.host}:${item.port}`))]
      state.lines.push(`network ${info.network}: refused ${refused.length} connection(s) to ${hosts.join(", ")}`)
    }
  }
  const failed = outcome.failed || result.failed
  const destroying = Sandbox.destroys(policy, { failed })
  try {
    state.outcome = await step(destroying ? "Removing the container" : "Stopping the container", () =>
      Sandbox.finish(info, { failed, commit: result.commit, files: result.files.length }, policy),
    )
    if (state.outcome === "destroyed") state.lines.push(`destroyed ${info.id} (container and volumes)`)
    else
      state.lines.push(
        `kept ${info.id} (stopped${failed && policy === "destroy_on_success" ? ", because the task failed" : ""}` +
          `${info.expires ? `, until ${info.expires}` : ""}): ` +
          `\`lunos sandbox attach ${info.id}\` reopens it, \`lunos sandbox destroy ${info.id}\` removes it`,
      )
  } catch (error) {
    // The results are back; only the clean-up didn't happen.
    RunLog.note("sandbox", `${info.id}: couldn't ${destroying ? "remove" : "stop"} it: ${RunLog.describe(error)}`)
    state.lines.push(
      `the results are back, but ${info.id} couldn't be ${destroying ? "removed" : "stopped"}: ${SandboxFailure.describe(error)}; ` +
        `\`lunos sandbox destroy ${info.id}\` removes it`,
    )
  }
  state.state = "done"
  state.finished = new Date().toISOString()
  save()
  return state
}

/** The helper's arguments: `lunos sandbox conclude <id> --background …`. */
export function concludeArgs(id: string, outcome: Outcome, policy: Sandbox.Meta["on_finish"]) {
  return [
    "sandbox",
    "conclude",
    id,
    "--background",
    "--label",
    outcome.label,
    "--policy",
    policy,
    ...(outcome.failed ? ["--failed"] : []),
  ]
}

/**
 * XCOD-301: start the helper, detached: its own process group (a session on Linux/macOS), so the
 * terminal's Ctrl+C and hang-up never reach it; on Windows without a console window, so closing
 * the terminal doesn't end it (untested there). False when it couldn't be started.
 */
export function spawnHelper(id: string, root: string, args: string[]) {
  SandboxConclude.write({ id, root, state: "running", started: new Date().toISOString(), steps: [], lines: [] })
  try {
    const self = Restart.selfCommand(args)
    const child = spawnProcess(self.argv[0], self.argv.slice(1), {
      cwd: self.cwd,
      env: self.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: self.verbatim,
    })
    child.on("error", (error) => RunLog.note("sandbox", `the background helper failed: ${RunLog.describe(error)}`))
    child.unref()
    if (child.pid !== undefined) return true
  } catch (error) {
    RunLog.note("sandbox", `couldn't start the background helper: ${RunLog.describe(error)}`)
  }
  rmSync(SandboxConclude.file(id), { force: true })
  return false
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * XCOD-301: `on_exit: "wait"`: follow the helper, a line per finished step with its time and a
 * spinner on the running one. Ctrl+C stops following (undefined); the helper goes on.
 */
export async function follow(id: string, print = say) {
  const tty = Boolean(process.stderr.isTTY)
  let shown = 0
  let frame = 0
  let interrupted = false
  const onInterrupt = () => {
    interrupted = true
  }
  process.on("SIGINT", onInterrupt)
  const clear = () => tty && process.stderr.write("\r\x1b[2K")
  try {
    while (true) {
      const state = SandboxConclude.current(id)
      clear()
      for (; state && shown < state.steps.length && state.steps[shown].finished; shown++)
        print(SandboxConclude.stepLine(state.steps[shown]))
      if (!state || state.state !== "running") return state
      if (interrupted) return undefined
      const running = state.steps[shown]
      if (tty)
        process.stderr.write(
          `${SPINNER[frame++ % SPINNER.length]} ${running ? SandboxConclude.stepLine(running) : "Starting…"}`,
        )
      await Bun.sleep(100)
    }
  } finally {
    process.off("SIGINT", onInterrupt)
    clear()
  }
}

/** A finished helper's report, as the foreground printed it before XCOD-301; failure sets the exit code. */
function report(state: SandboxConclude.State) {
  if (state.state === "failed") {
    UI.error(`Couldn't hand the results of sandbox ${state.id} back: ${state.reason ?? "unknown error"}`)
    process.exitCode = 1
  }
  for (const line of state.lines) say(line)
  if (state.state === "failed" && state.log) say(`log: ${state.log.file}`)
}

/** How long quitting may spend finding out whether anything changed, for its last line. */
const QUICK_CHECK = 600

/**
 * XCOD-301: Lunos is done with the sandbox. The detached helper hands the results back and applies
 * the lifecycle policy; "background" returns at once with one line saying so, "wait" follows it.
 * When the helper can't be started, the work is done here, as before.
 */
async function leave(
  info: Sandbox.Meta,
  conn: Sandbox.Connection,
  outcome: Outcome,
  mode: "background" | "wait",
  policy = info.on_finish,
) {
  RunLog.note("sandbox", `${info.id}: server ${conn.url}, workspace ${conn.directory}`)
  // The helper reads the metadata from disk: what changed here (attach clears the expiry) goes first.
  await Sandbox.persist(info).catch(() => {})
  if (!spawnHelper(info.id, info.root, concludeArgs(info.id, outcome, policy))) {
    for (const step of (await concludeWork(info, outcome, policy)).steps) say(SandboxConclude.stepLine(step))
    report(SandboxConclude.read(info.id)!)
    return
  }
  if (mode === "background") {
    const same = await Promise.race([
      Sandbox.unchanged(info, QUICK_CHECK).catch(() => false),
      Bun.sleep(QUICK_CHECK).then(() => false),
    ])
    const removing = Sandbox.destroys(policy, outcome) ? "Removing" : "Stopping"
    UI.println(
      same
        ? `No changes in the sandbox. ${removing} it in the background.`
        : `Saving your sandbox results in the background (sandbox ${info.id}) — \`lunos sandbox status ${info.id}\` to follow.`,
    )
    return
  }
  const state = await follow(info.id)
  if (state) return report(state)
  UI.println(`Continuing in the background (sandbox ${info.id}) — \`lunos sandbox status ${info.id}\` to follow.`)
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
    // XCOD-301: a handoff still running in the background for this project finishes first: the new
    // sandbox and the results branch never overlap it.
    await SandboxConclude.settle(directory, log)
    await pruneExpired(log)
    log("starting")
    const stored = await credentials()
    const info = await Sandbox.create({ directory, config, providers: Object.keys(stored), log })
    return { info, stored }
  })
  options.created?.(info)
  log(`${info.id}: image ${info.image.digest ?? info.image.id}, on_finish ${info.on_finish}`)
  try {
    const conn = await Sandbox.start(info, { secrets: secrets(stored), baseline: true })
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
    // XCOD-301: `lunos run` waits in CI and when piped (a job needs the results), unless sandbox.on_exit says.
    const mode = SandboxConfig.exitMode(SandboxConfig.load(info.root), "run")
    await leave(info, conn, { failed, label: failed ? "failed" : "finished" }, mode, policy)
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
  strict = false,
): SandboxState {
  const wrapped = SandboxFailure.wrap("create", error)
  RunLog.failure("sandbox", wrapped)
  const failure = failureInfo(wrapped, directory)
  // `--sandbox=strict` asks for no fallback, as a requirement does.
  if (strict && !failure.requiredBy) failure.requiredBy = "flag"
  if (failure.requiredBy) return { status: "blocked", failure }
  // XCOD-297: a change that turned the sandbox off isn't undone; that would turn it back on.
  const undone = SandboxRollback.revert(changes.filter(SandboxRollback.undoable))
  if (undone.length) {
    RunLog.note("the sandbox couldn't start; the change was undone", undone.join(", "))
    failure.reason += ` (your change to ${undone.map((key) => `\`${key}\``).join(", ")} was undone)`
  }
  if (SandboxConfig.load(directory).enabled) SandboxDisabled.set(directory, failure)
  return { status: "failed", failure }
}

/**
 * XCOD-281: whether the TUI starts with the sandbox. A relaunch after it failed doesn't (unless it's
 * required); a Retry does; otherwise `wanted`. XCOD-297: nor does the restart after turning it off.
 */
export function startsSandboxed(
  args: { sandbox?: boolean },
  directory: string,
  handoff?: { failed?: SandboxFailureInfo; retry?: boolean; off?: boolean },
) {
  if (SandboxConfig.load(directory).required) return true
  if (handoff?.failed || handoff?.off) return false
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
  const failure = handoff?.failed ?? SandboxEffective.resolve(directory).disabled
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

/**
 * XCOD-301: results from this project that a background handoff couldn't save, for the toast at
 * start; undefined when there are none (reading the files is all it costs). Retry runs the helper
 * again; Attach is remembered for `attachRequested`, which reopens it once the TUI has exited.
 */
export function sandboxHandback(
  directory: string,
): (SandboxHandback & { attachRequested(): string | undefined }) | undefined {
  const list = () =>
    SandboxConclude.unsaved(directory, Sandbox.exists).map((item) => ({
      id: item.id,
      reason: item.reason ?? "unknown error",
      ...(item.log ? { log: item.log } : {}),
    }))
  if (!list().length) return undefined
  let attach: string | undefined
  return {
    unsaved: list,
    async retry(id) {
      const before = SandboxConclude.read(id)
      const input = before?.input ?? { failed: false, label: "finished", policy: "retain" as const }
      if (!spawnHelper(id, before?.root ?? directory, concludeArgs(id, input, input.policy)))
        return { ok: false, reason: "the background helper couldn't be started" }
      while (SandboxConclude.busy(id)) await Bun.sleep(250)
      const state = SandboxConclude.current(id)
      if (state?.state !== "done") return { ok: false, reason: state?.reason ?? "unknown error" }
      const handed = state.steps.find(
        (step) => step.label === "Handing back results" || step.label === "Saving the transcript",
      )
      return { ok: true, detail: handed?.detail ?? "done" }
    },
    attach(id) {
      attach = id
    },
    attachRequested: () => attach,
  }
}

/**
 * XCOD-297: /settings' sandbox settings, read and written on this computer by this process while the
 * TUI is attached to a sandboxed server: the server's own writes land in the container's copy of the
 * config, and the sandbox is decided here, from these files, at the next start. Only `sandbox.*`.
 */
export function hostSettings(directory: string): NonNullable<SandboxHost["settings"]> {
  return {
    sandbox: () => SandboxEffective.view(SandboxEffective.resolve(directory)),
    async set(input): Promise<SandboxSaved> {
      if (!input.key.startsWith("sandbox."))
        return { ok: false, error: `${input.key} isn't saved on this computer from inside the sandbox` }
      const { ConfigSettings } = await import("@/config/settings")
      // The rows come from the server inside, which runs the project's plugins: nothing from there
      // may loosen the sandbox on this computer. What a repository can't choose (an open network, a
      // mount, the image) is refused here too; only turning it off is allowed, and the TUI asks first.
      const value = input.unset ? undefined : ConfigSettings.coerceKey(input.key, input.value)
      const weakens =
        input.key === "sandbox.image" ||
        (input.key === "sandbox.required" && value !== true) ||
        (!input.unset && ConfigSettings.projectRefusal(input.key, value))
      if (weakens)
        return {
          ok: false,
          error:
            `${input.key} can't be changed from inside a sandbox, since that would loosen it. ` +
            "Change it with `lunos settings set` on this computer, or in /settings when Lunos runs without the sandbox.",
        }
      const where = { ctx: { directory, worktree: SandboxConfig.worktreeOf(directory) }, via: "settings screen" }
      try {
        const result = input.unset
          ? await ConfigSettings.unset({ key: input.key, scope: input.scope, ...where })
          : await ConfigSettings.set({ key: input.key, value: input.value, scope: input.scope, ...where })
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
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
  args: Lifecycle & { strict?: boolean },
  restarted?: { changes?: SandboxRollback.Change[] },
) {
  // A wrong pair of flags isn't the sandbox failing to start: refused before anything, with no way round it.
  try {
    lifecycleOverride(args)
  } catch (error) {
    throw new SandboxError({ reason: SandboxFailure.describe(error) })
  }
  // XCOD-282: located without writing anything; a plain folder's workspace is the top ("" relative).
  const workdir = await SandboxGit.locate(directory)
    .then((found) => Sandbox.workdirOf(found.relative))
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
    failed: (error) => failed(error, directory, restarted?.changes ?? [], args.strict),
    // The first frame goes first: nothing of the sandbox's start-up competes with it.
    after: Promise.race([StartupTrace.waitFirstFrame(), Bun.sleep(1000)]),
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
    host: { ...background.host, settings: hostSettings(directory) } satisfies SandboxHost,
    directory: workdir ?? directory,
    /** Once the TUI has exited: hand the results back, or keep a sandbox that was still starting. */
    async finish() {
      process.off("SIGINT", interrupted)
      process.off("SIGTERM", interrupted)
      const conn = background.connection()
      if (conn && info) {
        // XCOD-301: no more "server …, workspace …" here: it was the last line on screen while the
        // results came back, and looked frozen. It's in the run log; the helper does the rest.
        const unsuccessful = process.exitCode !== undefined && process.exitCode !== 0
        await leave(
          info,
          conn,
          { failed: unsuccessful, label: unsuccessful ? "failed" : "finished" },
          SandboxConfig.exitMode(SandboxConfig.load(directory), "tui"),
        )
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

/**
 * XCOD-301: refused while a helper is handing this sandbox's results back: it starts and stops the
 * same container.
 */
async function notBusy(id: string) {
  if (SandboxConclude.busy(id))
    throw new Error(
      `Sandbox ${id} is still saving its results in the background. \`lunos sandbox status ${id}\` follows it; try again once it's done`,
    )
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
        row.meta?.source === "folder" ? `folder (lunos sandbox apply ${row.id})` : (row.meta?.branch ?? "-"),
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
    const info = yield* attempt(() => notBusy(args.id).then(() => Sandbox.meta(args.id)))
    yield* Effect.promise(async () => {
      // Reopened, it no longer expires on the old schedule; leaving it again sets a new one.
      info.expires = undefined
      const conn = await Sandbox.start(info, { secrets: secrets(await credentials()), attach: true })
      say(`${info.id}: server ${conn.url}, workspace ${conn.directory}`)
      try {
        await attachTui(conn, { continue: true })
      } finally {
        // A reopened sandbox is kept whatever on_finish says: it was retained to be inspected.
        const mode = SandboxConfig.exitMode(SandboxConfig.load(info.root), "attach")
        await leave(info, conn, { failed: false, label: "attached" }, mode, "retain")
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
    yield* attempt(() => notBusy(args.id).then(() => Sandbox.destroy(args.id)))
    yield* writeStdoutEffect(`Destroyed sandbox ${args.id}.${EOL}`)
  }),
})

export const SandboxApplyCommand = effectCmd({
  command: "apply <id>",
  describe:
    "write a sandbox's results into the folder it ran in (folders that aren't a git repository); refuses files you changed since",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.sandbox.apply")(function* (args) {
    yield* prepare
    const applied = yield* attempt(() => notBusy(args.id).then(() => Sandbox.apply(args.id)))
    const lines = [
      ...applied.written.map((file) => `  wrote    ${file}`),
      ...applied.deleted.map((file) => `  deleted  ${file}`),
    ]
    const count = applied.written.length + applied.deleted.length
    yield* writeStdoutEffect(
      [
        count
          ? `Applied sandbox ${args.id} to ${applied.root}: ${count} file${count === 1 ? "" : "s"}.`
          : `Nothing to apply: ${applied.root} already has sandbox ${args.id}'s results.`,
        ...lines,
        ...(applied.unchanged.length && count ? [`  (${applied.unchanged.length} already up to date)`] : []),
      ].join(EOL) + EOL,
    )
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
    const info = yield* attempt(() => notBusy(args.id).then(() => Sandbox.meta(args.id)))
    yield* attempt(() => Sandbox.retain(info, "stopped"))
    yield* writeStdoutEffect(`Stopped sandbox ${args.id}; it is kept.${EOL}`)
  }),
})

/**
 * XCOD-297: `lunos sandbox status`: whether the next start here uses the sandbox, and which files
 * decide it. Files only: no Docker, no project instance, so it works when nothing else starts.
 */
/** XCOD-301: `lunos sandbox status <id>`: where its background handoff is, or how it ended. */
export function statusLines(state: SandboxConclude.State, now = Date.now()) {
  const head = {
    running: `Sandbox ${state.id}: saving its results in the background`,
    done: `Sandbox ${state.id}: done, ${state.outcome === "destroyed" ? "results saved and the sandbox removed" : "results saved"}`,
    failed: `Sandbox ${state.id}: failed, the results weren't saved: ${state.reason ?? "unknown error"}`,
  }[state.state]
  return [
    head,
    ...state.steps.map(
      (step) =>
        `  ${step.finished ? "✓" : state.state === "running" ? "…" : "✗"} ${SandboxConclude.stepLine(step, now)}`,
    ),
    ...(state.state === "running" ? [] : state.lines.map((line) => `  ${line}`)),
    ...(state.log ? [`  log: ${state.log.file}`] : []),
  ]
}

export const SandboxStatusCommand = effectCmd({
  command: "status [id]",
  describe:
    "whether the sandbox is on here, and which config file turns it on; with an id, where that sandbox's results are (saving in the background, done, or failed and why)",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", describe: "a sandbox's id" }),
  handler: Effect.fn("Cli.sandbox.status")(function* (args) {
    if (args.id) {
      const id = args.id
      const state = SandboxConclude.current(id)
      if (state) return yield* writeStdoutEffect(statusLines(state).join(EOL) + EOL)
      yield* attempt(() => Sandbox.meta(id))
      return yield* writeStdoutEffect(`Sandbox ${id}: no results being saved or saved in the background.${EOL}`)
    }
    const directory = process.env.PWD ?? process.cwd()
    const state = SandboxEffective.resolve(directory)
    const view = SandboxEffective.view(state)
    const lines = [`Sandbox: ${view.display}`, `  ${view.detail}`]
    if (view.fixed && view.on) lines.push(`  ${view.fixed}`)
    else if (view.disabled) lines.push("  `lunos sandbox off` keeps it off; `lunos --sandbox` tries it again.")
    else if (view.on) lines.push("  `lunos sandbox off` turns it off.")
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})

/**
 * XCOD-297: `lunos sandbox off`: sandbox.enabled is set to false in each of your config files that
 * turns it on (any one of them does), or only the user's or the project's. Refused, with the reason,
 * under sandbox.required or an organisation lock. Files only, as `status`.
 */
export const SandboxOffCommand = effectCmd({
  command: "off",
  describe: "turn the sandbox off here: sets sandbox.enabled to false in the config files that turn it on",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("project", { type: "boolean", describe: "only this project's config files" })
      .option("user", { type: "boolean", describe: "only your own (global) config files" }),
  handler: Effect.fn("Cli.sandbox.off")(function* (args) {
    if (args.project && args.user)
      return yield* fail("--project and --user contradict each other; pass one, or neither")
    const directory = process.env.PWD ?? process.cwd()
    const turned = SandboxEffective.turnOff(directory, args.project ? "project" : args.user ? "user" : undefined)
    if (!turned.ok) return yield* fail(turned.reason)
    const lines = turned.files.length
      ? turned.files.map((file) => `sandbox.enabled is now false in ${file}`)
      : [turned.still ? "Nothing to change in those files." : "The sandbox is already off here."]
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
    if (turned.still) return yield* fail(turned.still.charAt(0).toUpperCase() + turned.still.slice(1))
    if (turned.files.length) yield* writeStdoutEffect(`The sandbox is off: Lunos starts without it from now on.${EOL}`)
  }),
})

/**
 * XCOD-301: hand a sandbox's results back and apply sandbox.on_finish. Quitting Lunos starts it
 * detached (`--background`); run by hand, it tries again after a failed handoff, with the same
 * policy unless --policy says otherwise.
 */
export const SandboxConcludeCommand = effectCmd({
  command: "conclude <id>",
  describe:
    "hand a sandbox's results back and apply sandbox.on_finish (what quitting Lunos runs in the background); tries again after a failed handoff",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("policy", {
        type: "string",
        choices: ["destroy", "retain", "destroy_on_success"] as const,
        describe: "what to do with it once the results are back (default: as before, else sandbox.on_finish)",
      })
      .option("failed", { type: "boolean", hidden: true })
      .option("label", { type: "string", hidden: true })
      .option("background", { type: "boolean", hidden: true }),
  handler: Effect.fn("Cli.sandbox.conclude")(function* (args) {
    const id = args.id
    yield* Effect.promise(() => hostAudit())
    // The process that started this helper marked it running already; run by hand, it may not overlap one.
    if (!args.background) yield* attempt(() => notBusy(id))
    const info = yield* attempt(() => Sandbox.meta(id))
    const before = SandboxConclude.read(id)?.input
    const outcome = {
      failed: args.failed ?? before?.failed ?? false,
      label: args.label ?? before?.label ?? "finished",
    }
    const policy = (args.policy as Sandbox.Meta["on_finish"] | undefined) ?? before?.policy ?? info.on_finish
    const state = yield* Effect.promise(() => concludeWork(info, outcome, policy))
    yield* Effect.promise(() => Promise.race([AuditLog.flush(), Bun.sleep(3000)]))
    if (!args.background) {
      for (const step of state.steps) say(SandboxConclude.stepLine(step))
      report(state)
    } else if (state.state === "failed") process.exitCode = 1
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
      .command(SandboxApplyCommand)
      .command(SandboxLogsCommand)
      .command(SandboxStopCommand)
      .command(SandboxConcludeCommand)
      .command(SandboxDestroyCommand)
      .command(SandboxPruneCommand)
      .command(SandboxDoctorCommand)
      .command(SandboxStatusCommand)
      .command(SandboxOffCommand)
      .command(SandboxEgressCommand)
      .demandCommand(),
  async handler() {},
})
