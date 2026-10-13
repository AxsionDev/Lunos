import fs from "fs/promises"
import path from "path"
import { EOL } from "os"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { CloudAuth } from "@/cloud/auth"
import { CloudOrg } from "@/cloud/org"
import { CloudShare } from "@/cloud/share"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"
import { sanitize } from "./export"

// XCOD-191: `lunos share` uploads one session (as `lunos export` writes it) or one artifact file to
// your organisation's Lunos console, for its members, and optionally makes a link that works
// without signing in until it expires. Never upstream's share service; never automatic.

const MAX_ARTIFACT_BYTES = 1024 * 1024

const out = (line: string) => process.stdout.write(line + EOL)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const ShareCommand = effectCmd({
  command: "share [sessionID]",
  describe: "share a session or an artifact with your organisation, on its Lunos console",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { type: "string", describe: "the session to share (lunos session list)" })
      .option("artifact", {
        type: "string",
        describe: "share this file (a plan, research note, …) instead of a session",
      })
      .option("title", {
        type: "string",
        describe: "title shown to your organisation (default: the session's or file's)",
      })
      .option("link", {
        type: "number",
        describe: "also make a link that works without signing in, for this many hours (at most 720)",
      })
      .option("sanitize", {
        type: "boolean",
        describe: "redact transcript and file data first, as lunos export --sanitize",
      }),
  handler: Effect.fn("Cli.share")(function* (args) {
    if (!args.sessionID === !args.artifact)
      return yield* fail("Name one session to share (lunos session list), or --artifact <file>.")
    if (args.link !== undefined && !(args.link > 0 && args.link <= 720))
      return yield* fail("--link is a number of hours, more than 0 and at most 720 (30 days).")
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const org = yield* Effect.promise(() => CloudOrg.resolve())
    if (!org) return yield* fail(new CloudOrg.NotConfiguredError("lunos share").message)

    let input: CloudShare.ShareInput
    if (args.artifact) {
      const file = path.resolve(args.artifact)
      const stat = yield* Effect.promise(() => fs.stat(file).catch(() => undefined))
      if (!stat?.isFile()) return yield* fail(`No file ${file}`)
      if (stat.size > MAX_ARTIFACT_BYTES) return yield* fail(`${file} is larger than 1 MB; share something smaller.`)
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
      const heading = /^#{1,3}\s+(.+?)\s*$/m.exec(text)?.[1]
      input = { kind: "artifact", title: args.title ?? heading ?? path.basename(file), content: text }
    } else {
      const svc = yield* Session.Service
      const id = SessionID.make(args.sessionID!)
      const data = yield* Effect.gen(function* () {
        const info = yield* svc.get(id)
        const messages = yield* svc.messages({ sessionID: info.id })
        return { info, messages }
      }).pipe(Effect.catchCause(() => fail(`Session not found: ${args.sessionID}`)))
      const content = args.sanitize ? sanitize(data) : data
      input = { kind: "session", title: args.title ?? data.info.title, content }
    }

    process.stderr.write(
      `Sharing ${input.kind === "session" ? `session "${input.title}"` : `"${input.title}"`} with ${org.org} on ${org.host}${args.link ? `, with a link for ${args.link} h` : ""}${EOL}`,
    )
    const shared = yield* Effect.tryPromise({
      try: () => CloudShare.upload(config, org, { ...input, linkHours: args.link }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        fail(
          error instanceof CloudAuth.SignedOutError || error instanceof CloudShare.RefusedError
            ? error.message
            : error instanceof CloudOrg.ConsoleError
              ? `Not shared: ${error.message}`
              : `Not shared: ${message(error)}`,
        ),
      ),
    )
    out(`Shared with ${org.org}: ${shared.url}`)
    if (shared.link) out(`Link (works without signing in until ${shared.link.expiresAt}): ${shared.link.url}`)
    out(`Revoke it on the console's Shares page (you, or an owner or admin of ${org.org}).`)
  }),
})
