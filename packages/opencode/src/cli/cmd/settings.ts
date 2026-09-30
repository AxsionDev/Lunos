import { EOL } from "os"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import { InstanceRef } from "@/effect/instance-ref"
import { ConfigSettings } from "@/config/settings"

// XCOD-128: `lunos settings` opens the TUI on the settings screen; `list`, `get` and `set` are the
// same list, read and write for scripts, with the same validation and organisation locks.

const rows = Effect.fn("Cli.settings.rows")(function* () {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const ctx = yield* InstanceRef
  const config = yield* Config.Service.use((cfg) => cfg.get())
  const origins = yield* Config.Service.use((cfg) => cfg.origins())
  const locked = yield* Effect.promise(() => ConfigSettings.lockedKeys())
  return yield* Effect.promise(() =>
    ConfigSettings.list({
      config,
      origins,
      locked,
      ctx: { directory: ctx?.directory ?? process.cwd(), worktree: ctx?.worktree },
    }),
  )
})

function badge(row: ConfigSettings.Row) {
  return row.locked ? "managed 🔒" : row.source
}

export const SettingsListCommand = effectCmd({
  command: "list",
  describe: "list every setting with its value and where it comes from",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false, describe: "print JSON" }),
  handler: Effect.fn("Cli.settings.list")(function* (args) {
    const list = yield* rows()
    if (args.json) return yield* writeStdoutEffect(JSON.stringify(list, null, 2) + EOL)
    const width = Math.max(...list.map((row) => row.key.length))
    const lines: string[] = []
    let category = ""
    for (const row of list) {
      if (row.category !== category) {
        category = row.category
        lines.push((lines.length ? EOL : "") + category)
      }
      const value = row.display.length > 60 ? row.display.slice(0, 59) + "…" : row.display
      lines.push(`  ${row.key.padEnd(width)}  ${value.padEnd(24)}  ${badge(row)}`)
    }
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})

export const SettingsGetCommand = effectCmd({
  command: "get <key>",
  describe: "print one setting's current value",
  builder: (yargs) =>
    yargs
      .positional("key", { type: "string", demandOption: true, describe: "setting key, e.g. share or compaction.auto" })
      .option("json", { type: "boolean", default: false, describe: "print the whole entry as JSON" }),
  handler: Effect.fn("Cli.settings.get")(function* (args) {
    const item = ConfigSettings.find(args.key)
    if (!item) return yield* fail(`Unknown setting "${args.key}". Run \`lunos settings list\` to see them all.`)
    const row = (yield* rows()).find((r) => r.key === item.key)!
    if (args.json) return yield* writeStdoutEffect(JSON.stringify(row, null, 2) + EOL)
    const value = typeof row.value === "string" ? row.value : JSON.stringify(row.value ?? null)
    yield* writeStdoutEffect(value + EOL)
  }),
})

export const SettingsSetCommand = effectCmd({
  command: "set <key> <value>",
  describe: "change one setting in your user config (or the project's, with --project)",
  builder: (yargs) =>
    yargs
      .positional("key", { type: "string", demandOption: true, describe: "setting key, e.g. share or compaction.auto" })
      .positional("value", { type: "string", demandOption: true, describe: "new value (JSON for lists and objects)" })
      .option("project", {
        type: "boolean",
        default: false,
        describe: "write to .opencode/opencode.json in this project instead of your user config",
      }),
  handler: Effect.fn("Cli.settings.set")(function* (args) {
    const ctx = yield* InstanceRef
    const result = yield* Effect.tryPromise({
      try: () =>
        ConfigSettings.set({
          key: args.key,
          value: String(args.value),
          scope: args.project ? "project" : "user",
          ctx: { directory: ctx?.directory ?? process.cwd(), worktree: ctx?.worktree },
          via: "lunos settings set",
        }),
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    const lines = [
      `${result.key} = ${JSON.stringify(result.value)} (${result.scope}: ${result.file})${result.changed ? "" : " — already set"}`,
    ]
    if (result.restart) lines.push("Restart Lunos for this to take effect.")
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})

export const SettingsCommand = cmd({
  command: "settings",
  describe: "view and change settings (opens the settings screen)",
  builder: (yargs) => yargs.command(SettingsListCommand).command(SettingsGetCommand).command(SettingsSetCommand),
  async handler() {
    const { TuiThreadCommand } = await import("./tui")
    await TuiThreadCommand.handler({ _: [], $0: "", settings: "settings" } as never)
  },
})
