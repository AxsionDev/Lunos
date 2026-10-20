import type { CommandModule } from "yargs"
import fs from "fs"
import os from "os"
import path from "path"
import { EOL } from "os"
import { RunLog } from "@opencode-ai/core/observability/run-log"
import { InstallationChannel, InstallationVersion, versionVerbose } from "@opencode-ai/core/installation/version"
import { Offline } from "@opencode-ai/core/offline"
import { SandboxConfig } from "@/sandbox/config"
import { Zip } from "@/util/zip"
import { redactConfig } from "./debug/redact"
import { Failure } from "../failure"
import { SandboxPreflight } from "@/sandbox/preflight"
import { checkLines } from "./sandbox"

/**
 * XCOD-280: `lunos logs` and `lunos bug-report`. Every run of Lunos writes a log (`RunLog`); a
 * failure's output ends with its path and short id. These find a log again by that id, and pack one,
 * redacted, for a bug report. Nothing is uploaded: the user attaches the zip themselves.
 */

function missing(id: string | undefined) {
  process.stderr.write(
    (id ? `No log with id ${id}.` : "No logs yet.") + ` Logs are in ${RunLog.dir()}; \`lunos logs\` lists them.${EOL}`,
  )
  process.exitCode = 1
}

export const LogsCommand = {
  command: "logs [id]",
  describe: "list recent runs' logs, or show one by its id",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", describe: "the log's short id, as printed when Lunos failed" })
      .option("open", { type: "boolean", describe: "open the log in the system's viewer" })
      .option("dir", { type: "boolean", describe: "print the log directory" }),
  handler: async (args) => {
    if (args.dir) {
      process.stdout.write(RunLog.dir() + EOL)
      return
    }
    if (!args.id && !args.open) {
      const entries = RunLog.list()
      if (entries.length === 0) return missing(undefined)
      const rows = entries.map((entry) =>
        [entry.id.padEnd(4), entry.time.toLocaleString().padEnd(22), entry.result.padEnd(10), entry.file].join("  "),
      )
      process.stdout.write(["ID    TIME                    RESULT      PATH", ...rows].join(EOL) + EOL)
      return
    }
    const entry = RunLog.find(args.id)
    if (!entry) return missing(args.id)
    if (args.open) {
      const { openPath } = await import("@opencode-ai/core/open")
      await openPath(entry.file)
      process.stderr.write(`Opened ${entry.file}${EOL}`)
      return
    }
    process.stdout.write(fs.readFileSync(entry.file, "utf8"))
  },
} satisfies CommandModule<{}, { id?: string; open?: boolean; dir?: boolean }>

/** Config keys that help explain a failure; the rest (agents, prompts, commands) stay out of a report. */
const REPORTED = [
  "model",
  "small_model",
  "enabled_providers",
  "disabled_providers",
  "provider",
  "mcp",
  "plugin",
  "sandbox",
  "residency",
  "audit",
  "memory",
  "share",
  "autoupdate",
  "server",
  "lsp",
  "log",
  "$locked",
]

/** Values that are never in a report: environments and headers whole, every secret-looking key. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if ((key === "environment" || key === "env" || key === "headers") && item && typeof item === "object")
        return [key, Object.fromEntries(Object.keys(item).map((name) => [name, "***"]))]
      return [key, scrub(item)]
    }),
  )
}

export function reportConfig(directory: string) {
  const doc = SandboxConfig.effectiveDoc(directory, undefined)
  const picked = Object.fromEntries(REPORTED.filter((key) => key in doc).map((key) => [key, doc[key]]))
  return RunLog.redact(JSON.stringify(redactConfig(scrub(picked)), null, 2))
}

function system() {
  const runtimes = ["docker", "podman"].map((bin) => {
    try {
      const result = Bun.spawnSync([bin, "version", "--format", "{{json .}}"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      })
      const out = (result.stdout.toString() + result.stderr.toString()).trim()
      return `${bin} version (exit ${result.exitCode ?? "none"}):${EOL}${out || "(no output)"}`
    } catch {
      return `${bin}: not installed`
    }
  })
  return [
    `os: ${os.type()} ${os.release()} (${process.platform}, ${process.arch})`,
    `node: ${process.versions.node}, bun: ${process.versions.bun}`,
    `executable: ${process.execPath}`,
    `log directory: ${RunLog.dir()}`,
    "",
    ...runtimes,
  ].join(EOL)
}

/**
 * What `lunos sandbox doctor` checks, without its slow, side-effecting part (pulling the image and
 * starting a test container): nothing a bug report makes should change this machine.
 */
export async function doctor(directory: string) {
  try {
    const checks = await SandboxPreflight.run({ directory, full: false })
    return [
      "lunos sandbox doctor (quick checks; `lunos sandbox doctor` also pulls the image and starts a test container)",
      "",
      ...checks.flatMap(checkLines),
    ].join(EOL)
  } catch (error) {
    return `lunos sandbox doctor couldn't run: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** The GitHub issue form, pre-filled with the version, OS and log id only: never the log itself. */
export function issueURL(id: string) {
  const url = new URL("https://github.com/AxsionDev/Lunos/issues/new?template=bug-report.yml")
  url.searchParams.set("title", `Lunos failed (log ${id})`)
  url.searchParams.set("lunos-version", `${InstallationVersion} (${InstallationChannel})`)
  url.searchParams.set("os", `${os.type()} ${os.release()} (${process.arch})`)
  url.searchParams.set(
    "reproduce",
    `Describe what you were doing. Attach lunos-bug-report-${id}.zip (made by \`lunos bug-report ${id}\`) after checking what it contains.`,
  )
  return url.toString()
}

export async function bugReport(input: { id?: string; output?: string; directory: string }) {
  const entry = RunLog.find(input.id)
  if (!entry) return undefined
  Failure.secrets(input.directory)
  const file = path.resolve(input.output ?? path.join(RunLog.dir(), `lunos-bug-report-${entry.id}.zip`))
  const archive = Zip.zip([
    { name: path.basename(entry.file), data: RunLog.redact(fs.readFileSync(entry.file, "utf8")) },
    { name: "version.txt", data: versionVerbose() + EOL + Offline.report() + EOL },
    { name: "config.json", data: reportConfig(input.directory) + EOL },
    { name: "system.txt", data: RunLog.redact(system()) + EOL },
    { name: "sandbox-doctor.txt", data: RunLog.redact(await doctor(input.directory)) + EOL },
    {
      name: "README.txt",
      data:
        "Made by `lunos bug-report`. Secrets (keys, tokens, passwords) are removed and prompts are never logged,\n" +
        "but look through these files before you share them. Nothing was uploaded.\n",
    },
  ])
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, archive)
  return { file, entry }
}

export const BugReportCommand = {
  command: "bug-report [id]",
  describe: "pack a run's log, redacted, with version and config details into a zip for a bug report",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", describe: "the log's short id (default: the latest run)" })
      .option("output", { alias: "o", type: "string", describe: "where to write the zip" })
      .option("issue", {
        type: "boolean",
        describe: "open a pre-filled GitHub issue page (the zip is never attached for you)",
      }),
  handler: async (args) => {
    const made = await bugReport({ id: args.id, output: args.output, directory: process.env.PWD ?? process.cwd() })
    if (!made) return missing(args.id)
    process.stdout.write(made.file + EOL)
    process.stderr.write(
      `Made ${Failure.link(made.file)}${EOL}` +
        `It contains the log of run ${made.entry.id}, the version, the config (secrets removed), system details and the sandbox checks.${EOL}` +
        `Check it, then attach it to an issue: nothing was uploaded.${EOL}`,
    )
    if (!args.issue) {
      process.stderr.write(`To open a pre-filled issue: lunos bug-report ${made.entry.id} --issue${EOL}`)
      return
    }
    const url = issueURL(made.entry.id)
    const { openUrl } = await import("@opencode-ai/core/open")
    await openUrl(url).catch(() => process.stderr.write(`Open this page: ${url}${EOL}`))
  },
} satisfies CommandModule<{}, { id?: string; output?: string; issue?: boolean }>
