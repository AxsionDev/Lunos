import { EOL } from "os"
import { Effect, Option } from "effect"
import { Offline } from "@opencode-ai/core/offline"
import { CloudGitToken } from "@/cloud/git-token"
import { CloudQuickstartCommand } from "./cloud-quickstart"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import { writeStdoutEffect } from "../stdout"

// XCOD-243: `lunos cloud git-token set <host>` / `rm <host>`: the git token Lunos Cloud clones and
// pushes with, without curl. The token is read from stdin (piped) or a hidden prompt, never from an
// argument, so it doesn't land in shell history or `ps`. Nothing ever prints it back.

const failWith = (error: unknown) => fail(error instanceof Error ? error.message : String(error))

const online = Effect.gen(function* () {
  if (Offline.enabled()) return yield* fail(Offline.message("Storing a git token with Lunos Cloud"))
})

/** The token: piped on stdin, or typed at a hidden prompt. */
const readToken = Effect.fn("Cli.cloud.gitToken.read")(function* (host: string) {
  if (!process.stdin.isTTY) return (yield* Effect.promise(() => Bun.stdin.text())).trim()
  const value = yield* Prompt.password({
    message: `Git token for ${host} (input hidden)`,
    validate: (x) => (x && x.trim().length > 0 ? undefined : "Required"),
  })
  return Option.isNone(value) ? "" : value.value.trim()
})

export const CloudGitTokenSetCommand = effectCmd({
  command: "set <host>",
  describe: "store or replace the git token Lunos Cloud uses for a host (read from stdin or a hidden prompt)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("host", { type: "string", demandOption: true, describe: "git host, e.g. github.com" })
      .option("username", {
        type: "string",
        describe: "user name git sends with the token (default x-access-token, for GitHub)",
      }),
  handler: Effect.fn("Cli.cloud.gitToken.set")(function* (args) {
    yield* online
    const host = yield* Effect.try({
      try: () => CloudGitToken.normaliseHost(String(args.host)),
      catch: (error) => error,
    }).pipe(Effect.catch(failWith))
    const token = yield* readToken(host)
    if (!token)
      return yield* fail(
        "No token given. Pipe it in (… | lunos cloud git-token set github.com) or type it at the prompt.",
      )
    const result = yield* Effect.tryPromise({
      try: () => CloudGitToken.set({ host, token, username: args.username }),
      catch: (error) => error,
    }).pipe(Effect.catch(failWith))
    yield* writeStdoutEffect(`Saved your git token for ${result.host} on ${new URL(result.base).host}.${EOL}`)
  }),
})

export const CloudGitTokenRmCommand = effectCmd({
  command: "rm <host>",
  aliases: ["remove"],
  describe: "remove the git token Lunos Cloud keeps for a host",
  instance: false,
  builder: (yargs) =>
    yargs.positional("host", { type: "string", demandOption: true, describe: "git host, e.g. github.com" }),
  handler: Effect.fn("Cli.cloud.gitToken.rm")(function* (args) {
    yield* online
    const result = yield* Effect.tryPromise({
      try: () => CloudGitToken.remove({ host: String(args.host) }),
      catch: (error) => error,
    }).pipe(Effect.catch(failWith))
    yield* writeStdoutEffect(`Removed your git token for ${result.host} on ${new URL(result.base).host}.${EOL}`)
  }),
})

export const CloudGitTokenCommand = cmd({
  command: "git-token",
  describe: "the git tokens Lunos Cloud clones and pushes with",
  builder: (yargs) => yargs.command(CloudGitTokenSetCommand).command(CloudGitTokenRmCommand).demandCommand(),
  async handler() {},
})

export const CloudCommand = cmd({
  command: "cloud",
  describe: "Lunos Cloud: your first cloud run, and account settings",
  builder: (yargs) => yargs.command(CloudGitTokenCommand).command(CloudQuickstartCommand).demandCommand(),
  async handler() {},
})
