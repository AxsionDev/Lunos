import type { CommandModule } from "yargs"
import path from "path"

// XCOD-177: the third-party licence notices, built into the binary (script/notices.ts writes them
// at build time; build.ts defines LUNOS_THIRD_PARTY_NOTICES), so this works offline.
declare const LUNOS_THIRD_PARTY_NOTICES: string | undefined

export const NOT_BUILT =
  "Licence notices are generated when Lunos is built. From source, run: bun packages/opencode/script/notices.ts"

export function notices() {
  return typeof LUNOS_THIRD_PARTY_NOTICES === "undefined" ? undefined : LUNOS_THIRD_PARTY_NOTICES
}

export const LicensesCommand = {
  command: "licenses",
  describe: "show the licences of the third-party software Lunos includes",
  builder: (yargs) =>
    yargs.option("output", {
      alias: "o",
      describe: "write the notices to this file instead of printing them",
      type: "string",
    }),
  handler: async (args) => {
    const text = notices()
    if (!text) {
      process.stderr.write(NOT_BUILT + "\n")
      process.exitCode = 1
      return
    }
    if (!args.output) {
      process.stdout.write(text)
      return
    }
    const file = path.resolve(args.output)
    await Bun.write(file, text)
    process.stderr.write(`Wrote the licence notices to ${file}\n`)
  },
} satisfies CommandModule<{}, { output?: string }>
