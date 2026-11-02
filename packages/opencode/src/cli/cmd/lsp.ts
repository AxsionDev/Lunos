import { LSP } from "@/lsp/lsp"
import { Effect } from "effect"
import { EOL } from "os"
import { effectCmd } from "../effect-cmd"
import { cmd } from "./cmd"
import { writeStdoutEffect } from "../stdout"

/**
 * XCOD-257: `lunos lsp status [--file <path>] [--json]`: every language server Lunos knows and its
 * state, as /lsp shows it. A fresh process has nothing running, so `--file` opens a file first and
 * shows how its servers started, or why they didn't.
 */
export const LspCommand = cmd({
  command: "lsp",
  describe: "language servers: what's running, what failed and why",
  builder: (yargs) => yargs.command(StatusCommand).demandCommand(),
  async handler() {},
})

const STATE: Record<LSP.Server["state"], string> = {
  running: "running",
  starting: "starting…",
  failed: "failed",
  not_started: "not started",
  disabled: "off",
}

export function summary(overview: LSP.Overview) {
  const count = (state: LSP.Server["state"]) => overview.servers.filter((item) => item.state === state).length
  const diagnostics = overview.servers.reduce((total, item) => total + (item.diagnostics ?? 0), 0)
  return [
    `LSP is ${overview.enabled ? "on" : "off"} · downloads ${overview.downloads ? "allowed" : "off"}`,
    `${count("running")} running · ${count("failed")} failed · ${count("not_started")} not started · ${diagnostics} diagnostics`,
  ]
}

export function line(item: LSP.Server) {
  const detail = [
    item.reason,
    item.source,
    item.root ? `root ${item.root}` : undefined,
    item.pid ? `pid ${item.pid}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
  return `${item.id.padEnd(22)} ${STATE[item.state].padEnd(12)} ${detail}`.trimEnd()
}

const StatusCommand = effectCmd({
  command: "status",
  describe: "list every language server and its state",
  builder: (yargs) =>
    yargs
      .option("file", { type: "string", describe: "open this file first, so its servers start" })
      .option("json", { type: "boolean", describe: "print JSON" }),
  handler: Effect.fn("Cli.lsp.status")(function* (args) {
    const overview = yield* LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        if (args.file) yield* lsp.touchFile(args.file, "document")
        return yield* lsp.overview()
      }),
    )
    if (args.json) return yield* writeStdoutEffect(JSON.stringify(overview, null, 2) + EOL)
    yield* writeStdoutEffect([...summary(overview), "", ...overview.servers.map(line)].join(EOL) + EOL)
  }),
})
