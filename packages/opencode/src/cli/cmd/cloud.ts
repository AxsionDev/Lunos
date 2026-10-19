import { EOL } from "os"
import { Effect } from "effect"
import { openUrl } from "@opencode-ai/core/open"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigOrgPolicy } from "@/config/org-policy"
import { ConfigPolicy } from "@/config/policy"
import { CloudAuth } from "@/cloud/auth"
import { CloudDefaults } from "@/cloud/defaults"
import { CloudHosted } from "@/cloud/hosted"
import { CloudOidc } from "@/cloud/oidc"
import { CloudStore } from "@/cloud/store"
import { CloudSyncApi } from "@/cloud/sync-api"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// XCOD-185: `lunos login` / `logout` / `whoami` for Lunos Cloud, with the OAuth device flow
// against the configured OpenID Connect issuer. Nothing else in Lunos needs a login, and nothing
// asks for one: the free harness works the same signed out.

export const DEFAULT_CLIENT_ID = "lunos-cli"

const out = (line: string) => process.stdout.write(line + EOL)
const dim = (text: string) => UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL

const where = (backend: CloudStore.Backend) =>
  backend === "keychain"
    ? "the macOS Keychain"
    : backend === "secret-service"
      ? "the system keyring"
      : "a file only you can read"

/**
 * Session sync's part of `lunos login` (XCOD-185), after the sign-in is stored: register this device
 * and show the first-sync notice once. Only for Lunos's own issuer, or with `cloud.endpoint` set
 * explicitly: an organisation's token isn't sent to Lunos Cloud by default.
 */
export async function loginSync(input: {
  issuer: string
  locked: boolean
  print: (line: string) => void
  opts?: CloudSyncApi.Options
}) {
  if (!(await CloudSyncApi.permitted(input.issuer))) return input.print(CloudSyncApi.NEEDS_ENDPOINT)
  const state = await CloudSyncApi.register({ timeoutMs: 5_000, ...input.opts }).catch((error) => {
    input.print(dim(`Session sync isn't set up: ${error instanceof Error ? error.message : String(error)}`))
    return undefined
  })
  if (state) await CloudSyncApi.notice(state, input.locked, input.print)
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
    if (!/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer))
      return yield* fail(`${issuer} isn't an https URL; sign-in tokens must not travel in the clear.`)
    const clientID = args.clientId ?? config.cloud?.client_id ?? DEFAULT_CLIENT_ID
    const result = yield* Effect.tryPromise({
      try: async () => {
        const discovery = await CloudOidc.discover(issuer)
        const device = await CloudOidc.startDevice(discovery, clientID)
        const link = device.verification_uri_complete ?? device.verification_uri
        out(`Open ${link}`)
        out(`and confirm the code ${UI.Style.TEXT_HIGHLIGHT_BOLD}${device.user_code}${UI.Style.TEXT_NORMAL}`)
        if (args.browser) await openUrl(link).catch(() => undefined)
        out(dim("Waiting for you to approve it in the browser… (ctrl+c to cancel)"))
        const tokens = await CloudOidc.waitForTokens(discovery, clientID, device)
        const user = await CloudOidc.user(discovery, tokens)
        const backend = await CloudStore.save({
          issuer: discovery.issuer ?? issuer,
          clientID,
          tokens,
          email: user.email,
          sub: user.sub,
          savedAt: new Date().toISOString(),
        })
        return { user, backend, issuer: discovery.issuer ?? issuer, tokens }
      },
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    out(`Signed in as ${result.user.email ?? result.user.preferred_username ?? result.user.sub} ${dim(`(${issuer})`)}`)
    out(dim(`Session kept in ${where(result.backend)}. lunos logout signs out.`))
    // Registering the device never fails the login, nor holds it up for long (5 s per request).
    yield* Effect.promise(() =>
      loginSync({
        issuer: result.issuer,
        locked: config.sync === false && ConfigPolicy.isLocked(config.$locked, "sync"),
        print: out,
      }).catch((error) =>
        out(dim(`Session sync isn't set up: ${error instanceof Error ? error.message : String(error)}`)),
      ),
    )
    // XCOD-242: team features for the account's hosted organisation, unless managed config decides
    // (it sets cloud.policy, or cloud.auto_team: false): then nothing is looked up, exactly as before.
    const hosted = yield* Effect.promise(async () => {
      const onDisk = await ConfigManaged.readOnDiskDocs().catch(() => [] as unknown[])
      if (ConfigOrgPolicy.policyURL(onDisk) || ConfigOrgPolicy.autoTeamOff(onDisk)) {
        await CloudHosted.clear()
        return { kind: "none" } as const
      }
      return CloudHosted.afterLogin({ issuer: result.issuer, sub: result.user.sub, tokens: result.tokens })
    })
    const line = CloudHosted.describe(hosted)
    if (line) out(hosted.kind === "on" ? line : dim(line))
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout",
  describe: "sign out of Lunos Cloud and revoke this machine's session",
  instance: false,
  handler: Effect.fn("Cli.cloud.logout")(function* () {
    const session = yield* Effect.promise(() => CloudStore.load())
    if (!session) return out("Not signed in.")
    // Revoke first, so the refresh token stops working even if a copy exists somewhere.
    const revoked = yield* Effect.promise(async () => {
      try {
        return await CloudOidc.revoke(await CloudOidc.discover(session.issuer), session.clientID, session.tokens)
      } catch {
        return false
      }
    })
    yield* Effect.promise(() => CloudStore.clear())
    yield* Effect.promise(() => CloudHosted.clear())
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
        return CloudOidc.user(fresh.discovery, fresh.tokens)
      },
      catch: (error) => error,
    }).pipe(Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))))
    out(user.email ?? user.preferred_username ?? user.sub)
    out(dim(`issuer ${session.issuer}`))
    if (user.organizations?.length) out(dim(`organisations ${user.organizations.join(", ")}`))
  }),
})
