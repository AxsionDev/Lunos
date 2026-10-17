import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import semver from "semver"
import { Installation } from "../../installation"
import { InstallationVersion, manualInstallCommand } from "@opencode-ai/core/installation/version"
import { createUpdateProgress, updateProgressMode } from "../update-progress"

/** "Lunos is up to date (1.18.43)." when nothing newer is published. */
export function upToDateMessage(version: string) {
  return `Lunos is up to date (${version}).`
}

/**
 * Whether `lunos update` has nothing to do. An explicit target only counts when it's the installed
 * version; with no target, anything not newer than the installed version (a preview build ahead of
 * `latest`, say) is "up to date" too.
 */
export function isUpToDate(current: string, target: string, explicit: boolean) {
  if (current === target) return true
  if (explicit || !semver.valid(current) || !semver.valid(target)) return false
  return !semver.gt(target, current)
}

/** The copy-paste command for a failed update, per install method (XCOD-111 for npm). */
export function manualUpdateCommand(method: Installation.Method, target: string) {
  if (method === "npm") return manualInstallCommand(target)
  return `${method} install -g ${Installation.PACKAGE}@${target}`
}

// XCOD-147: `update` is the name in help and docs; `upgrade` stays a working alias so no script breaks.
export const UpgradeCommand = {
  command: "update [target]",
  aliases: ["upgrade"],
  describe: "update Lunos to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to update to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["npm", "pnpm", "bun"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    // XCOD-247: off a terminal (pipes, CI) everything is plain text: no logo, no colours, no spinner.
    const mode = updateProgressMode(process.stdout.isTTY)
    const plain = mode === "plain"
    const info = (text: string) => (plain ? console.log(text) : prompts.log.info(text))
    const error = (text: string) => (plain ? console.log(text) : prompts.log.error(text))
    const outro = (text: string) => (plain ? console.log(text) : prompts.outro(text))
    if (!plain) {
      UI.empty()
      UI.println(UI.logo("  "))
      UI.empty()
      prompts.intro("Update")
    }
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method !== "npm" && method !== "pnpm" && method !== "bun") {
      if (plain) console.log(`Lunos is installed to ${process.execPath}`)
      else prompts.log.warn(`Lunos is installed to ${process.execPath}`)
      error(Installation.unpublishedMessage(method))
      outro("Done")
      return
    }
    info("Using method: " + method)

    const progress = createUpdateProgress({ mode, write: (text) => process.stdout.write(text) })
    // The package manager runs in its own process group, so Ctrl+C reaches only this process: it
    // cancels while nothing has been installed yet, and otherwise says why it won't.
    const interrupt = () => {
      if (progress.step === "checking" || progress.step === undefined) {
        progress.stop()
        outro(`Update cancelled, still on ${InstallationVersion}.`)
        process.exit(130)
      }
      progress.note("Can't cancel while installing; Lunos would be left half-updated. It will finish on its own.")
    }
    process.on("SIGINT", interrupt)
    try {
      if (!args.target) progress.set("checking")
      const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

      if (isUpToDate(InstallationVersion, target, !!args.target)) {
        progress.stop()
        outro(upToDateMessage(InstallationVersion))
        return
      }

      progress.stop()
      info(`From ${InstallationVersion} → ${target}`)
      const err = await Installation.upgrade(method, target, (step) => progress.set(step, target)).catch((err) => err)
      progress.stop()
      if (err) {
        error("Update failed")
        if (err instanceof Installation.UpgradeFailedError) {
          error(err.stderr)
          info(`To update manually, run: ${manualUpdateCommand(method, target)}`)
        } else if (err instanceof Error) error(err.message)
        outro("Done")
        process.exitCode = 1
        return
      }
      info("Update complete")
      outro("Restart Lunos to use v" + target)
    } finally {
      progress.stop()
      process.off("SIGINT", interrupt)
    }
  },
}
