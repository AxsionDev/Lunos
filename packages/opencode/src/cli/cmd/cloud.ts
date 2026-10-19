import { EOL } from "os"
import { Effect } from "effect"
import { openUrl } from "@opencode-ai/core/open"
import { Config } from "@/config/config"
import { ConfigPolicy } from "@/config/policy"
import { CloudAuth } from "@/cloud/auth"
import { CloudDefaults } from "@/cloud/defaults"
import { CloudOidc } from "@/cloud/oidc"
import { CloudSignin } from "@/cloud/signin"
import { CloudStore } from "@/cloud/store"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// XCOD-185: `lunos login` / `logout` / `whoami` for Lunos Cloud, with the OAuth device flow
// against the configured OpenID Connect issuer. XCOD-273: the TUI's Welcome screen runs the same
// sign-in (cloud/signin.ts); the official build asks for it at start, unless an exemption applies.

export const DEFAULT_CLIENT_ID = "lunos-cli"

const out = (line: string) => process.stdout.write(line + EOL)
const dim = (text: string) => UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL

/**
 * `lunos login`'s sign-in, in line mode: also the official build's sign-in for `lunos --mini` and
 * `lunos --sandbox`, which have no Welcome screen. Throws with a message on failure.
 */
export async function lineSignIn(input: { issuer: string; clientID: string; browser: boolean; syncLocked: boolean }) {
  const started = await CloudSignin.begin({ issuer: input.issuer, clientID: input.clientID })
  const link = started.device.verification_uri_complete ?? started.device.verification_uri
  out(`Open ${link}`)
  out(`and confirm the code ${UI.Style.TEXT_HIGHLIGHT_BOLD}${started.device.user_code}${UI.Style.TEXT_NORMAL}`)
  if (input.browser) await openUrl(link).catch(() => undefined)
  out(dim("Waiting for you to approve it in the browser… (ctrl+c to cancel)"))
  const confirmed = await CloudSignin.complete(started)
  if (CloudSignin.unverified(confirmed))
    throw new Error(
      `Confirm your e-mail address first: open the link in the e-mail sent to ${confirmed.user.email ?? "you"}, then run lunos login again.`,
    )
  // Session sync and team features report after the sign-in line, as before.
  const notes: string[] = []
  const kept = await CloudSignin.keep(confirmed, { syncLocked: input.syncLocked, print: (line) => notes.push(line) })
  out(
    `Signed in as ${confirmed.user.email ?? confirmed.user.preferred_username ?? confirmed.user.sub} ${dim(`(${input.issuer})`)}`,
  )
  out(dim(`Session kept in ${CloudSignin.where(kept.backend)}. lunos logout signs out.`))
  for (const line of notes) out(kept.hosted.kind === "on" && line.startsWith("Team features: on") ? line : dim(line))
  return confirmed
}

/**
 * XCOD-273: the official build's account check for the starts without a Welcome screen (`--mini`,
 * `--sandbox`). Nothing happens with an exemption or a stored sign-in; otherwise the Welcome copy and
 * `lunos login`'s device flow, in line mode. False when the sign-in failed and the start must stop.
 */
export async function requireLineSignIn() {
  const { CloudGate } = await import("@/cloud/gate")
  const { gate, issuer, clientID } = await CloudGate.current()
  if (!gate.required || (await CloudStore.load())) return true
  out(UI.Style.TEXT_HIGHLIGHT_BOLD + "Welcome to Lunos" + UI.Style.TEXT_NORMAL)
  out("Create a free Lunos account to start. No card needed.")
  out(dim("Free: the full harness, CLI, TUI, desktop app and every local feature. Paid plans add cloud features."))
  const { CloudTuiHost } = await import("@/cloud/tui-host")
  const legal = CloudTuiHost.LEGAL
  out(dim(`Terms: ${legal.terms}  ·  Privacy notice: ${legal.privacy}`))
  // The same consent as the Welcome screen's checkbox: asked, never assumed.
  const { createInterface } = await import("readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl
    .question("Accept the Terms and the Privacy notice and sign in? [y/N] ")
    .finally(() => rl.close())
  if (!/^y(es)?$/i.test(answer.trim())) {
    UI.error(
      "Lunos needs a free account to start. Run lunos again to sign in, or see “Using Lunos without an account”.",
    )
    return false
  }
  return lineSignIn({ issuer, clientID, browser: true, syncLocked: false }).then(
    async () => {
      await CloudTuiHost.create({ gate, issuer, clientID }).accept(legal.version)
      return true
    },
    (error: unknown) => {
      UI.error(error instanceof Error ? error.message : String(error))
      return false
    },
  )
}

export const LoginCommand = effectCmd({
  command: "login",
  describe: "sign in to Lunos Cloud (or your organisation's identity provider)",
  builder: (yargs) =>
    yargs
      .option("issuer", {
        type: "string",
        describe: `OpenID Connect issuer URL (default: cloud.issuer or ${CloudDefaults.DEFAULT_ISSUER})`,
      })
      .option("client-id", {
        type: "string",
        describe: `OAuth client id (default: cloud.client_id or ${DEFAULT_CLIENT_ID})`,
      })
      .option("browser", {
        type: "boolean",
        default: true,
        describe: "open the sign-in page (--no-browser just prints the link)",
      }),
  handler: Effect.fn("Cli.cloud.login")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const issuer = args.issuer ?? config.cloud?.issuer ?? CloudDefaults.DEFAULT_ISSUER
    const refused = CloudSignin.insecure(issuer)
    if (refused) return yield* fail(refused)
    const clientID = args.clientId ?? config.cloud?.client_id ?? DEFAULT_CLIENT_ID
    yield* Effect.tryPromise({
      try: () =>
        lineSignIn({
          issuer,
          clientID,
          browser: args.browser,
          syncLocked: config.sync === false && ConfigPolicy.isLocked(config.$locked, "sync"),
        }),
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout",
  describe: "sign out of Lunos Cloud and revoke this machine's session",
  instance: false,
  handler: Effect.fn("Cli.cloud.logout")(function* () {
    const { session, revoked } = yield* Effect.promise(() => CloudSignin.logout())
    if (!session) return out("Not signed in.")
    if (session.fromEnv) return out(`Signed in with ${CloudStore.TOKEN_ENV}; unset it to sign out.`)
    out(`Signed out${session.email ? ` ${session.email}` : ""}.`)
    if (!revoked)
      out(dim("The identity provider couldn't be told; the session ends when its tokens expire, or revoke it there."))
  }),
})

export const WhoamiCommand = effectCmd({
  command: "whoami",
  describe: "show who you're signed in to Lunos Cloud as",
  instance: false,
  handler: Effect.fn("Cli.cloud.whoami")(function* () {
    const session = yield* Effect.promise(() => CloudStore.load())
    if (!session) return yield* fail("Not signed in. Run lunos login.")
    const user = yield* Effect.tryPromise({
      try: async () => {
        const fresh = await CloudAuth.session()
        return CloudOidc.user(fresh.discovery ?? (await CloudOidc.discover(fresh.issuer)), fresh.tokens)
      },
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    out(user.email ?? user.preferred_username ?? user.sub)
    out(dim(`issuer ${session.issuer}`))
    if (user.organizations?.length) out(dim(`organisations ${user.organizations.join(", ")}`))
  }),
})
