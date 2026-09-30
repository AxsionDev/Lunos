// XCOD-157: first, so a sandbox's runtime values are in the environment before any module reads it.
import "./sandbox/boot"
import yargs from "yargs"
import { ConfigPolicy } from "@/config/policy"
import { AuditLog } from "@/audit/log"
import { AuditForward } from "@/audit/forward"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion, versionVerbose } from "@opencode-ai/core/installation/version"
import { Offline } from "@opencode-ai/core/offline"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { MarketplaceCommand } from "./cli/cmd/marketplace"
import { AuditCommand } from "./cli/cmd/audit"
import { MemoryCommand } from "./cli/cmd/memory"
import { SettingsCommand } from "./cli/cmd/settings"
import { SandboxCommand } from "./cli/cmd/sandbox"
import { Heap } from "./cli/heap"
import { brandHelp } from "./cli/brand"
import { Restart } from "./cli/restart"

const args = hideBin(process.argv)

// XCOD-118: `lunos --version --verbose` adds the upstream base and the lag at the last sync, and
// (XCOD-121) whether offline mode is on and which outbound calls it turned off.
if (args.length === 2 && args.includes("--verbose") && (args.includes("--version") || args.includes("-v"))) {
  process.stdout.write(versionVerbose() + EOL + Offline.report() + EOL)
  process.exit(0)
}

// Plain one-shot commands get the once-a-day "new version" stderr line. The TUI has its own
// reminder, and long-running servers or the update flow itself shouldn't print it.
const NOTICE_COMMANDS = new Set([
  "run",
  "mcp",
  "marketplace",
  "plugin",
  "models",
  "providers",
  "agent",
  "session",
  "stats",
  "export",
  "import",
  "github",
  "pr",
  "db",
  "debug",
])

// Commands that start a Lunos server on this machine, other than `lunos` and `lunos run`, which
// sandbox themselves when sandbox.required is set.
const HOST_SERVER_COMMANDS = new Set(["serve", "web", "acp", "github", "pr"])

// XCOD-147: the check starts with the command, not after it, so a finished command rarely waits
// for the registry. Set in the middleware, after the log/env flags are applied.
let pendingNotice: Promise<void> | undefined
// A finished command gives a still-running check this long before it falls back to the cache, so
// a slow or unreachable registry never holds up a command by the full 3 s timeout.
const NOTICE_GRACE = 300
let commandDone: () => void = () => {}
const commandFinished = new Promise<void>((resolve) => (commandDone = resolve)).then(() => Bun.sleep(NOTICE_GRACE))

function show(out: string) {
  out = brandHelp(out)
  const text = out.trimStart()
  if (!text.startsWith("lunos ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("lunos")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    // XCOD-157: with sandbox.required, these would run a server, and so agents and tools, on the host.
    const command = String(opts._[0] ?? "")
    if (HOST_SERVER_COMMANDS.has(command)) {
      const [{ refuseHost }, { CliError }] = await Promise.all([
        import("./cli/cmd/sandbox"),
        import("./cli/effect-cmd"),
      ])
      const refused = await refuseHost(`\`lunos ${command}\``)
      if (refused) throw new CliError({ message: refused, exitCode: 1 })
    }

    if (!pendingNotice && NOTICE_COMMANDS.has(String(opts._[0] ?? ""))) {
      pendingNotice = import("./cli/upgrade").then(({ notice }) => notice({ until: commandFinished })).catch(() => {})
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(MarketplaceCommand)
  .command(AuditCommand)
  .command(MemoryCommand)
  .command(SettingsCommand)
  .command(SandboxCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

// XCOD-103: every refused policy override lands in the audit trail, whichever surface refused it.
ConfigPolicy.onRefused((refusal) => AuditLog.emit("policy.override_refused", { key: refusal.key, via: refusal.via }))
AuditLog.onActivate(AuditForward.start)

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
    // The check had the whole command to finish; past the grace period it uses the cached result.
    // The outer bound only guards against a stuck config load.
    commandDone()
    if (pendingNotice) await Promise.race([pendingNotice, Bun.sleep(4000)])
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // XCOD-129: a relaunch after /restart that failed to start says how to start Lunos by hand.
  if (process.exitCode) Restart.reportFailedStart()
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses. Audit events are flushed first, bounded, so
  // a short-lived command can't exit before its last events are written (XCOD-103).
  await Promise.race([AuditLog.flush(), Bun.sleep(3000)])
  // Forwarded lines are sent asynchronously; give them a moment to leave before exiting.
  if (AuditLog.current()?.enabled && AuditLog.current()?.forward) await Bun.sleep(200)
  process.exit()
}
