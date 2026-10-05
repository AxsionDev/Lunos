import { EOL } from "os"
import { Effect } from "effect"
import { Audit } from "@opencode-ai/core/audit"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import { AuditLog } from "@/audit/log"

// XCOD-103: the audit trail's review surface. Both commands read the file the resolved config
// points at (`audit.path`, else `residency.auditPath`, else the default), or `--file`.
const fileOf = Effect.fn("Cli.audit.file")(function* (file: unknown) {
  if (typeof file === "string" && file) return file
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.get())
  return AuditLog.resolve(config).file
})

const fileOption = { type: "string" as const, describe: "audit log to read (default: the configured one)" }

export const AuditVerifyCommand = effectCmd({
  command: "verify",
  describe: "check that no line of the audit log was edited, removed or inserted",
  builder: (yargs) => yargs.option("file", fileOption),
  handler: Effect.fn("Cli.audit.verify")(function* (args) {
    const file = yield* fileOf(args.file)
    const result = yield* Effect.promise(() => Audit.verify(file))
    if (!result.ok)
      return yield* fail(`Audit log FAILED verification: ${result.file}, line ${result.line}: ${result.reason}`)
    yield* writeStdoutEffect(
      `Audit log OK: ${result.lines} lines in ${result.files} file(s), chain unbroken (${file})${EOL}`,
    )
  }),
})

export const AuditExportCommand = effectCmd({
  command: "export",
  describe: "print audit events as JSON lines or CSV",
  builder: (yargs) =>
    yargs
      .option("file", fileOption)
      .option("since", { type: "string", describe: "only events at or after this date/time (ISO 8601)" })
      .option("format", { choices: ["jsonl", "csv"] as const, default: "jsonl" as const }),
  handler: Effect.fn("Cli.audit.export")(function* (args) {
    const file = yield* fileOf(args.file)
    const since = args.since ? new Date(args.since) : undefined
    if (since && Number.isNaN(since.getTime())) return yield* fail(`--since is not a date: ${args.since}`)
    const rows = yield* Effect.promise(() => Audit.read(file, since))
    const out =
      args.format === "csv"
        ? Audit.toCsv(rows)
        : rows.map((row) => JSON.stringify(row)).join(EOL) + (rows.length ? EOL : "")
    yield* writeStdoutEffect(out)
  }),
})

export const AuditCommand = cmd({
  command: "audit",
  describe: "verify and export the organisation audit trail",
  builder: (yargs) => yargs.command(AuditVerifyCommand).command(AuditExportCommand).demandCommand(),
  handler: () => {},
})
