import fs from "fs/promises"
import path from "path"
import { EOL } from "os"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { CloudAuth } from "@/cloud/auth"
import { CloudOrg } from "@/cloud/org"
import { CloudShare } from "@/cloud/share"
import { CloudShareRecord } from "@/cloud/share-record"
import { CloudStore } from "@/cloud/store"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"

// XCOD-191: `lunos share` uploads one session (as `lunos export` writes it) or one artifact file to
// your organisation's Lunos console, for its members, and optionally makes a link that works
// without signing in until it expires. Never upstream's share service; never automatic.
//
// `lunos share list` and `lunos share revoke <id>` are subcommands. `list` and `revoke` can't be
// session ids (those always start with "ses_"), so `lunos share <session>` keeps working as is.

const MAX_ARTIFACT_BYTES = 1024 * 1024

const out = (line: string) => process.stdout.write(line + EOL)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The console's errors, as one line to print. */
const notDone = (what: string) => (error: unknown) =>
  fail(
    error instanceof CloudAuth.SignedOutError || error instanceof CloudShare.RefusedError
      ? error.message
      : `${what}: ${message(error)}`,
  )

const resolveOrg = (what: string) =>
  Effect.gen(function* () {
    const org = yield* Effect.promise(() => CloudOrg.resolve())
    if (!org) return yield* fail(new CloudOrg.NotConfiguredError(what).message)
    return org
  })

const when = (value: number | string | null | undefined) => {
  if (value === undefined || value === null) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** The link column: the latest link still working, or a count from a console that doesn't say. */
function links(share: CloudShare.Listed) {
  const now = Date.now()
  const live =
    share.activeLinks ??
    (Array.isArray(share.links)
      ? share.links.filter((l) => !l.revokedAt && new Date(l.expiresAt).getTime() > now)
      : undefined)
  if (!live) return typeof share.links === "number" && share.links ? `${share.links} link(s)` : "no link"
  if (!live.length) return "no link"
  const last = live.map((l) => new Date(l.expiresAt).getTime()).sort((a, b) => b - a)[0]!
  return `link until ${when(last)}${live.length > 1 ? ` (+${live.length - 1})` : ""}`
}

export const ShareListCommand = effectCmd({
  command: "list",
  describe: "list your shares on your organisation's Lunos console",
  instance: false,
  builder: (yargs) =>
    yargs.option("all", {
      type: "boolean",
      default: false,
      describe: "every share in the organisation, not only yours",
    }),
  handler: Effect.fn("Cli.share.list")(function* (args) {
    const org = yield* resolveOrg("lunos share list")
    const { shares, linkPolicy } = yield* Effect.tryPromise({
      try: () => CloudShare.list(org, { all: args.all }),
      catch: (e) => e,
    }).pipe(Effect.catch(notDone("Couldn't list shares")))
    // A console that ignores ?mine=1 lists everyone's: keep yours only.
    const me = (yield* Effect.promise(() => CloudStore.load().catch(() => undefined)))?.sub
    const shown = args.all || !me ? shares : shares.filter((s) => s.createdBy === undefined || s.createdBy === me)
    if (!shown.length) {
      out(`No shares${args.all ? "" : " of yours"} with ${org.org} on ${org.host}.`)
      return
    }
    for (const share of shown) {
      const state = share.revokedAt ? `revoked ${when(share.revokedAt)}` : links(share)
      out(
        [share.id, share.kind, JSON.stringify(share.title), when(share.createdAt) ?? "", state, share.url ?? ""]
          .filter(Boolean)
          .join("  "),
      )
    }
    if (linkPolicy)
      out(
        `Links in ${org.org} work for ${hours(linkPolicy.defaultHours)} by default, at most ${hours(linkPolicy.maxHours)}.`,
      )
  }),
})

const hours = (h: number) => (h % 24 ? `${h} hours` : `${h / 24} days`)

export const ShareRevokeCommand = effectCmd({
  command: "revoke <id>",
  describe: "revoke one of your shares and its links (its content is deleted on the console)",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true, describe: "lunos share list" }),
  handler: Effect.fn("Cli.share.revoke")(function* (args) {
    const org = yield* resolveOrg("lunos share revoke")
    const id = String(args.id)
    yield* Effect.tryPromise({ try: () => CloudShare.revoke(org, id), catch: (e) => e }).pipe(
      Effect.catch(notDone("Not revoked")),
    )
    yield* Effect.promise(() => CloudShareRecord.forgetShare(id).catch(() => undefined))
    out(`Revoked ${id} on ${org.host}, and its links: they stop working now.`)
  }),
})

/**
 * `--link` alone means the console's default expiry (30 days, or less if your organisation set a
 * shorter maximum); `--link <hours>` asks for that many. yargs gives a bare `--link` as "", and
 * `--link ses_…` would take the session id as its value, so that is put back.
 */
function link(raw: string | undefined, sessionID: string | undefined, artifact: string | undefined) {
  if (raw === undefined) return { sessionID }
  if (raw === "") return { sessionID, link: true as const }
  const hours = Number(raw)
  if (Number.isFinite(hours)) return { sessionID, link: hours }
  if (!sessionID && !artifact) return { sessionID: raw, link: true as const }
  return { sessionID, invalid: true }
}

export const ShareCommand = effectCmd({
  command: "share [sessionID]",
  describe: "share a session or an artifact with your organisation, on its Lunos console",
  builder: (yargs) =>
    yargs
      .command(ShareListCommand)
      .command(ShareRevokeCommand)
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
        type: "string",
        describe:
          "also make a link that works without signing in: for 30 days, or --link <hours> (your organisation may set a shorter maximum)",
      })
      .option("sanitize", {
        type: "boolean",
        describe: "redact transcript and file data first, as lunos export --sanitize",
      }),
  handler: Effect.fn("Cli.share")(function* (args) {
    const parsed = link(args.link, args.sessionID, args.artifact)
    if (parsed.invalid) return yield* fail("--link is a number of hours, or nothing for 30 days.")
    const sessionID = parsed.sessionID
    if (!sessionID === !args.artifact)
      return yield* fail("Name one session to share (lunos session list), or --artifact <file>.")
    if (typeof parsed.link === "number" && !(parsed.link > 0 && parsed.link <= 720))
      return yield* fail("--link is a number of hours, more than 0 and at most 720 (30 days).")
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const org = yield* resolveOrg("lunos share")

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
      input = yield* CloudShare.sessionInput(SessionID.make(sessionID!), {
        sanitize: args.sanitize,
        title: args.title,
      }).pipe(Effect.catchCause(() => fail(`Session not found: ${sessionID}`)))
    }

    const linkText =
      parsed.link === true
        ? ", with a link (30 days by default)"
        : parsed.link
          ? `, with a link for ${parsed.link} h`
          : ""
    process.stderr.write(
      `Sharing ${input.kind === "session" ? `session "${input.title}"` : `"${input.title}"`} with ${org.org} on ${org.host}${linkText}${EOL}`,
    )
    const shared = yield* Effect.tryPromise({
      try: () => CloudShare.upload(config, org, { ...input, linkHours: parsed.link }),
      catch: (error) => error,
    }).pipe(Effect.catch(notDone("Not shared")))
    // Deleting the session revokes it too: the console doesn't know which session it came from.
    const recorded =
      input.kind === "session" &&
      (yield* Effect.promise(() =>
        CloudShareRecord.record(sessionID!, org, shared).then(
          () => true,
          () => false,
        ),
      ))
    if (input.kind === "session" && !recorded)
      process.stderr.write(
        `Couldn't note which session this share came from, so deleting the session won't revoke it: revoke it yourself.${EOL}`,
      )
    out(`Shared with ${org.org}: ${shared.url}`)
    if (shared.link) out(`Link (works without signing in until ${shared.link.expiresAt}): ${shared.link.url}`)
    out(`Revoke it with: lunos share revoke ${shared.id}${recorded ? " (deleting the session revokes it too)" : ""}`)
  }),
})
