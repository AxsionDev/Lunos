import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Effect } from "effect"
import type { Argv } from "yargs"
import { Offline } from "@opencode-ai/core/offline"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Restart } from "../restart"
import { AuditLog } from "@/audit/log"
import { AgentJobs } from "@/agent/jobs"
import { AgentSchedule } from "@/agent/schedule"
import { AgentUnattended } from "@/agent/unattended"

// XCOD-211: `lunos agent run` (now, or on a schedule) and `lunos agent schedule list|remove`.
// The run itself is src/agent/unattended.ts; the OS job files are src/agent/schedule.ts.

const DEFAULTS = { time: "30m", cost: 2, steps: 50 }

/** The Lunos this process is, to run as a child (same binary, or bun plus the entry script). */
function self(): AgentUnattended.Spawn {
  const command = Restart.resolveCommand({
    execPath: process.execPath,
    argv: process.argv,
    execArgv: process.execArgv,
    args: [],
    upgraded: false,
    platform: process.platform,
    which: (name) => Bun.which(name),
    exists: existsSync,
  })
  return { file: command.file, base: command.base }
}

async function notify(url: string, report: AgentUnattended.Report, file: string) {
  if (Offline.enabled()) return "skipped: offline mode is on"
  if (!url.startsWith("https://")) return "skipped: --notify needs an https URL"
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Metadata only: never the prompt or the agent's output.
    body: JSON.stringify({
      agent: report.agent,
      job: report.job,
      status: report.status,
      reason: report.reason,
      steps: report.steps,
      cost: report.cost,
      seconds: report.seconds,
      denied: report.denied.map((item) => item.permission),
      report: file,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => error as Error)
  if (response instanceof Error) return `failed: ${response.message}`
  return response.ok ? "sent" : `failed: HTTP ${response.status}`
}

/** A desktop notification when a run didn't finish cleanly. Best effort, macOS and Linux. */
function desktop(report: AgentUnattended.Report) {
  const message = `${report.agent}: ${report.status} (${report.reason})`
  if (process.platform === "darwin") {
    const text = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    spawnSync("osascript", ["-e", `display notification ${text(message)} with title "Lunos"`], { stdio: "ignore" })
  } else if (process.platform === "linux") spawnSync("notify-send", ["Lunos", message], { stdio: "ignore" })
}

async function execute(input: {
  agent: string
  prompt: string
  cwd: string
  limits: AgentJobs.Limits
  sandbox: boolean
  notify?: string
  job?: string
}) {
  const report = await AgentUnattended.run({ command: self(), ...input })
  const dir = path.join(AgentJobs.runs(), input.job ?? input.agent.replaceAll("/", "_"))
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${report.started.replaceAll(":", "-")}.json`)
  await fs.writeFile(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
  AuditLog.emit("agent.run", {
    agent: report.agent,
    job: report.job,
    status: report.status,
    reason: report.reason,
    steps: report.steps,
    cost: report.cost,
    seconds: report.seconds,
    denied: report.denied.map((item) => item.permission),
    sandbox: report.sandbox,
  })
  const sent = input.notify ? await notify(input.notify, report, file) : undefined
  if (report.status !== "ok") desktop(report)
  return { report, file, sent }
}

function print(result: Awaited<ReturnType<typeof execute>>) {
  const { report, file, sent } = result
  UI.println(
    `${report.agent}: ${report.status} (${report.reason}) in ${report.seconds}s, ${report.steps} steps, cost ${report.cost}`,
  )
  for (const item of report.denied)
    UI.println(`  refused (nobody to approve): ${item.permission} ${item.patterns.join(", ")}`)
  if (report.edited.length) UI.println(`  files changed by edit tools: ${report.edited.join(", ")}`)
  if (report.error) UI.println(`  error: ${report.error}`)
  if (sent) UI.println(`  notification: ${sent}`)
  UI.println(`  report: ${file}`)
}

// ---------------------------------------------------------------------------------------------
// Installing the operating system's job

interface Installed {
  files: string[]
  describe: string[]
}

function sh(file: string, args: string[]) {
  const result = spawnSync(file, args, { encoding: "utf8" })
  if (result.status !== 0)
    throw new Error(
      `${file} ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    )
}

function artifacts(job: AgentJobs.Job, command: string[], cron: AgentSchedule.Cron) {
  const log = path.join(AgentJobs.logs(), `${job.id}.log`)
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${AgentSchedule.launchdLabel(job.id)}.plist`)
    return { files: { [file]: AgentSchedule.launchdPlist({ id: job.id, command, cwd: job.cwd, log, cron }) } }
  }
  if (process.platform === "linux") {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user")
    const units = AgentSchedule.systemdUnits({ id: job.id, command, cwd: job.cwd, cron })
    const name = AgentSchedule.systemdName(job.id)
    return {
      files: { [path.join(dir, `${name}.service`)]: units.service, [path.join(dir, `${name}.timer`)]: units.timer },
    }
  }
  if (process.platform === "win32")
    return { files: {}, schtasks: AgentSchedule.schtasksArgs({ id: job.id, command, cron }) }
  throw new AgentSchedule.Unsupported(`Scheduling isn't supported on ${process.platform}`)
}

async function install(job: AgentJobs.Job, plan: ReturnType<typeof artifacts>): Promise<Installed> {
  await fs.mkdir(AgentJobs.logs(), { recursive: true })
  const written: string[] = []
  try {
    for (const [file, content] of Object.entries(plan.files)) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, content, { flag: "wx" })
      written.push(file)
    }
    if (process.platform === "darwin") sh("launchctl", ["bootstrap", `gui/${process.getuid!()}`, written[0]])
    if (process.platform === "linux") {
      sh("systemctl", ["--user", "daemon-reload"])
      sh("systemctl", ["--user", "enable", "--now", `${AgentSchedule.systemdName(job.id)}.timer`])
    }
    if (process.platform === "win32") sh("schtasks", plan.schtasks!)
    return { files: written, describe: written }
  } catch (error) {
    for (const file of written) await fs.rm(file, { force: true })
    throw error
  }
}

function uninstall(job: AgentJobs.Job) {
  const errors: string[] = []
  const attempt = (file: string, args: string[]) => {
    try {
      sh(file, args)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (job.installed.platform === "darwin")
    attempt("launchctl", ["bootout", `gui/${process.getuid!()}/${AgentSchedule.launchdLabel(job.id)}`])
  if (job.installed.platform === "linux")
    attempt("systemctl", ["--user", "disable", "--now", `${AgentSchedule.systemdName(job.id)}.timer`])
  if (job.installed.platform === "win32")
    attempt("schtasks", ["/Delete", "/F", "/TN", AgentSchedule.schtasksName(job.id)])
  return errors
}

// ---------------------------------------------------------------------------------------------
// Commands

export const AgentRunCommand = effectCmd({
  command: "run [name]",
  describe: "run an agent unattended, now or on a schedule, with hard limits; nothing is auto-approved",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", { type: "string", describe: "agent to run" })
      .option("prompt", { alias: ["p"], type: "string", describe: "what the agent should do" })
      .option("schedule", { type: "string", describe: 'cron schedule, local time (e.g. "30 9 * * 1-5")' })
      .option("max-time", { type: "string", default: DEFAULTS.time, describe: "stop after this long (90s, 30m, 2h)" })
      .option("max-cost", { type: "number", default: DEFAULTS.cost, describe: "stop once model spend passes this" })
      .option("max-steps", {
        type: "number",
        default: DEFAULTS.steps,
        describe: "stop after this many steps, subagents included",
      })
      .option("sandbox", {
        type: "boolean",
        default: true,
        describe: "run in a Docker sandbox (--no-sandbox to run here)",
      })
      .option("notify", { type: "string", describe: "https URL to POST the run's outcome to (metadata only)" })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "with --schedule: show the job files, install nothing",
      })
      .option("job", { type: "string", hidden: true, describe: "run a scheduled job (used by the OS scheduler)" }),
  handler: Effect.fn("Cli.agent.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))

    if (args.job) {
      const job = yield* Effect.promise(() => AgentJobs.get(String(args.job)))
      if (!job) return yield* fail(`No scheduled job ${args.job} (see \`lunos agent schedule list\`)`)
      const release = yield* Effect.promise(() => AgentJobs.lock(job.id))
      if (!release) return yield* fail(`Job ${job.id} is already running`)
      const result = yield* Effect.promise(() => execute({ ...job, job: job.id }).finally(release))
      print(result)
      if (result.report.status !== "ok") return yield* fail(`${job.agent} ${result.report.status}`)
      return
    }

    const name = args.name ? String(args.name) : undefined
    if (!name) return yield* fail("Name the agent to run")
    if (!args.prompt) return yield* fail("Pass --prompt: an unattended run has nobody to ask")
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const agent = agents.find((item) => item.name === name)
    if (!agent) return yield* fail(`No agent named "${name}" (see \`lunos agent list\`)`)
    if (agent.mode === "subagent")
      return yield* fail(`${name} is a subagent; run a primary agent (mode primary or all) that can use it`)

    let time: number
    try {
      time = AgentUnattended.duration(String(args["max-time"]))
    } catch (error) {
      return yield* fail((error as Error).message)
    }
    const limits: AgentJobs.Limits = { time, cost: Number(args["max-cost"]), steps: Number(args["max-steps"]) }
    if (!(limits.cost > 0) || !(limits.steps > 0) || !(limits.time > 0))
      return yield* fail("--max-time, --max-cost and --max-steps must be above zero")
    if (args.notify && !String(args.notify).startsWith("https://")) return yield* fail("--notify needs an https URL")

    const base = {
      agent: name,
      prompt: String(args.prompt),
      cwd: process.cwd(),
      limits,
      sandbox: Boolean(args.sandbox),
      notify: args.notify,
    }

    if (!args.schedule) {
      const result = yield* Effect.promise(() => execute(base))
      print(result)
      if (result.report.status !== "ok") return yield* fail(`${name} ${result.report.status}`)
      return
    }

    let cron: AgentSchedule.Cron
    try {
      cron = AgentSchedule.parse(String(args.schedule))
    } catch (error) {
      return yield* fail((error as Error).message)
    }
    const job: AgentJobs.Job = {
      id: AgentJobs.newId(),
      ...base,
      cron: cron.source,
      created: new Date().toISOString(),
      installed: { platform: process.platform, files: [] },
    }
    // The job runs this Lunos later, from a scheduler with no shell: it must be an installed binary.
    const command = self()
    if (command.base.length && !args["dry-run"])
      return yield* fail(
        "Schedule from an installed lunos, not from a source checkout (the job would run bun from here)",
      )
    const argv = [command.file, ...command.base, "agent", "run", "--job", job.id]

    let plan: ReturnType<typeof artifacts>
    try {
      plan = artifacts(job, argv, cron)
    } catch (error) {
      return yield* fail((error as Error).message)
    }
    UI.println(`${name} will run ${AgentSchedule.describe(cron)} in ${job.cwd}`)
    UI.println(
      `  limits: ${args["max-time"]}, cost ${limits.cost}, ${limits.steps} steps; sandbox ${job.sandbox ? "on" : "off"}`,
    )
    UI.println("  Nobody approves anything in a scheduled run: every permission prompt is refused and reported.")
    UI.println("  Scheduled runs don't load your shell profile: providers set up only through environment variables")
    UI.println("  won't be available (use `lunos providers login`).")
    if (process.platform === "linux")
      UI.println("  systemd user timers only run while you're logged in, unless `loginctl enable-linger` is set.")
    if (args["dry-run"]) {
      for (const [file, content] of Object.entries(plan.files)) UI.println(`--- ${file}\n${content}`)
      if (plan.schtasks) UI.println(`schtasks ${plan.schtasks.join(" ")}`)
      return
    }
    const installed = yield* Effect.promise(() =>
      install(job, plan).then(
        (value) => value,
        (error: Error) => error,
      ),
    )
    if (installed instanceof Error) return yield* fail(installed.message)
    yield* Effect.promise(() =>
      AgentJobs.add({ ...job, installed: { platform: process.platform, files: installed.files } }),
    )
    UI.println(`Scheduled as job ${job.id} (lunos agent schedule remove ${job.id} to stop it)`)
  }),
})

const ScheduleListCommand = effectCmd({
  command: "list",
  describe: "list scheduled agents",
  instance: false,
  handler: Effect.fn("Cli.agent.schedule.list")(function* () {
    const jobs = yield* Effect.promise(() => AgentJobs.list())
    if (!jobs.length) return UI.println("No scheduled agents")
    for (const job of jobs) {
      let when = job.cron
      try {
        when = AgentSchedule.describe(AgentSchedule.parse(job.cron))
      } catch {}
      UI.println(`${job.id}  ${job.agent}  ${when}  in ${job.cwd}`)
    }
  }),
})

const ScheduleRemoveCommand = effectCmd({
  command: "remove <id>",
  describe: "stop and remove a scheduled agent",
  instance: false,
  builder: (yargs: Argv) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.agent.schedule.remove")(function* (args) {
    const job = yield* Effect.promise(() => AgentJobs.get(String(args.id)))
    if (!job) return yield* fail(`No scheduled job ${args.id}`)
    const errors = uninstall(job)
    yield* Effect.promise(async () => {
      for (const file of job.installed.files) await fs.rm(file, { force: true })
      if (job.installed.platform === "linux") spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
      await AgentJobs.remove(job.id)
    })
    for (const error of errors) UI.println(`  warning: ${error}`)
    UI.println(`Removed job ${job.id} (${job.agent})`)
  }),
})

export const AgentScheduleCommand = cmd({
  command: "schedule",
  describe: "manage scheduled agents",
  builder: (yargs) => yargs.command(ScheduleListCommand).command(ScheduleRemoveCommand).demandCommand(),
  async handler() {},
})
