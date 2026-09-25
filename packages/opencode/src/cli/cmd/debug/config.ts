import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { writeStdoutEffect } from "../../stdout"

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) =>
    yargs.option("sources", {
      type: "boolean",
      default: false,
      describe: "show which layer set each key (managed, global, project, env, remote) and whether it is locked",
    }),
  handler: Effect.fn("Cli.debug.config")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { ConfigPolicy } = yield* Effect.promise(() => import("@/config/policy"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    if (!args.sources) return yield* writeStdoutEffect(JSON.stringify(config, null, 2) + EOL)
    const origins = yield* Config.Service.use((cfg) => cfg.origins())
    const rows = Object.entries(origins)
      .filter(([key]) => key !== "$schema" && key !== ConfigPolicy.FIELD)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, origin]) => {
        const locked = ConfigPolicy.isLocked(config.$locked, key) ? "locked" : ""
        return [key, origin.layer, locked, origin.source]
      })
    const width = (i: number) => Math.max(...rows.map((row) => row[i].length), 0)
    const lines = rows.map((row) => row.map((cell, i) => (i < 3 ? cell.padEnd(width(i)) : cell)).join("  "))
    yield* writeStdoutEffect(["KEY".padEnd(width(0)) + "  LAYER", ...lines].join(EOL) + EOL)
  }),
})
