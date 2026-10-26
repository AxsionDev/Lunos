import { cmd } from "../cmd"
import { StartupTrace } from "@opencode-ai/core/startup-trace"

export const StartupCommand = cmd({
  command: "startup [project]",
  describe: "time the TUI's start, phase by phase, to its first frame",
  builder: (yargs) =>
    yargs.positional("project", { type: "string", describe: "path to start in" }).option("settle", {
      type: "number",
      default: 2000,
      describe: "ms to keep running after the first frame, so background work shows up too",
    }),
  async handler(args) {
    // Same timeline as LUNOS_STARTUP_TRACE=1; a path in it still gets the file.
    if (!StartupTrace.enabled()) process.env[StartupTrace.ENV] = "1"
    process.env.LUNOS_SURFACE = "tui"
    const { TuiThreadCommand, startupProbe } = await import("../tui")
    startupProbe.settle = args.settle
    startupProbe.quit = true
    await TuiThreadCommand.handler({ ...args, project: args.project, _: [], $0: "lunos" } as never)
  },
})
