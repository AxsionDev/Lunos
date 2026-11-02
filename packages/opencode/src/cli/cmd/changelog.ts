import type { Argv } from "yargs"
import { Changelog } from "@opencode-ai/core/changelog"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

/** XCOD-248: `lunos changelog [--since <version>] [--full] [--json]`, from the CHANGELOG built in. */
export const ChangelogCommand = {
  command: "changelog",
  describe: "show what changed in Lunos, from the notes built into this version",
  builder: (yargs: Argv) =>
    yargs
      .option("since", {
        describe: "show the versions after this one (default: only the version you have)",
        type: "string",
      })
      .option("full", { describe: "print the full notes instead of the summary", type: "boolean" })
      .option("json", { describe: "print the entries as JSON", type: "boolean" }),
  handler: (args: { since?: string; full?: boolean; json?: boolean }) => {
    const all = Changelog.versions()
    // A development build has no version of its own; it shows up to the newest release noted.
    const to = Changelog.current(InstallationVersion, all) ?? "0.0.0"
    const since = args.since?.replace(/^v/, "")
    if (since && !Changelog.isVersion(since)) {
      console.error(`"${args.since}" isn't a version, for example 1.18.43`)
      process.exitCode = 1
      return
    }
    const picked = since ? Changelog.range(since, to, all) : Changelog.range(undefined, to, all).slice(0, 1)
    if (args.json) {
      console.log(
        JSON.stringify(
          picked.flatMap((version) =>
            version.entries.map((entry) => ({
              version: entry.version,
              section: entry.section,
              text: entry.text,
              // XCOD-253: no ticket ids on anything users read; `tickets` was dropped.
              internal: entry.internal,
            })),
          ),
          null,
          2,
        ),
      )
      return
    }
    if (args.full) {
      for (const version of picked)
        console.log(
          `## ${version.version}${version.date ? ` - ${version.date}` : ""}\n\n${version.markdown || `No notes for ${version.version}.`}\n`,
        )
      return
    }
    // Without --since, the summary covers just the current version: since the release before it.
    console.log(Changelog.summary({ since: since ?? Changelog.previous(to, all), to, all }).join("\n"))
  },
}

/**
 * XCOD-248: the summary `lunos update` prints after a successful install. This process still has the
 * old version's notes built in, so it asks the newly installed `lunos` first and falls back to its own
 * (which says "No notes for X.Y.Z" when it predates that version).
 */
export async function updateNotes(from: string, to: string) {
  const since = Changelog.isVersion(from) ? from : undefined
  const bin = Bun.which("lunos")
  if (bin) {
    const proc = Bun.spawn([bin, "changelog", ...(since ? ["--since", since] : [])], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, NO_COLOR: "1" },
    })
    const timer = setTimeout(() => proc.kill(), 10_000)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).finally(() =>
      clearTimeout(timer),
    )
    if (code === 0 && out.includes(`Lunos ${to}`)) return out.trimEnd()
  }
  return Changelog.summary({ since, to }).join("\n")
}
