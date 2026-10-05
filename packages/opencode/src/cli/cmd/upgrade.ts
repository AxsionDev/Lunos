import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import semver from "semver"
import { Installation } from "../../installation"
import { InstallationVersion, manualInstallCommand } from "@opencode-ai/core/installation/version"

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
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Update")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method !== "npm" && method !== "pnpm" && method !== "bun") {
      prompts.log.warn(`Lunos is installed to ${process.execPath}`)
      prompts.log.error(Installation.unpublishedMessage(method))
      prompts.outro("Done")
      return
    }
    prompts.log.info("Using method: " + method)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (isUpToDate(InstallationVersion, target, !!args.target)) {
      prompts.outro(upToDateMessage(InstallationVersion))
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Updating...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Update failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        prompts.log.error(err.stderr)
        prompts.log.info(`To update manually, run: ${manualUpdateCommand(method, target)}`)
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Update complete")
    prompts.outro("Restart Lunos to use v" + target)
  },
}
