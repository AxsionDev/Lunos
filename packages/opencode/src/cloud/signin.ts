export * as CloudSignin from "./signin"

import type { FailureKind } from "@opencode-ai/tui/util/account"
import { ConfigManaged } from "@/config/managed"
import { ConfigOrgPolicy } from "@/config/org-policy"
import { CloudHosted } from "./hosted"
import { CloudOidc } from "./oidc"
import { CloudStore } from "./store"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-273: the one sign-in. `lunos login` (XCOD-185) and the TUI's Welcome screen both run these
 * three steps, so they share the device flow, the token store (keychain) and what follows a sign-in
 * (session sync's device, hosted team features). Nothing here prints: callers pass `print`.
 */

/** Tokens travel only over https, or to this machine. Undefined when `issuer` is fine. */
export function insecure(issuer: string) {
  if (/^https:\/\//.test(issuer) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer)) return
  return `${issuer} isn't an https URL; sign-in tokens must not travel in the clear.`
}

export type Started = { issuer: string; clientID: string; discovery: CloudOidc.Discovery; device: CloudOidc.DeviceCode }

/** Asks the provider for a device code. */
export async function begin(input: { issuer: string; clientID: string }): Promise<Started> {
  const refused = insecure(input.issuer)
  if (refused) throw new CloudOidc.OidcError(refused, "insecure")
  const discovery = await CloudOidc.discover(input.issuer)
  const device = await CloudOidc.startDevice(discovery, input.clientID)
  return { ...input, issuer: discovery.issuer ?? input.issuer, discovery, device }
}

export type Confirmed = Started & { tokens: CloudOidc.Tokens; user: CloudOidc.User }

/** Polls until the browser confirms the code, then asks who signed in. */
export async function complete(started: Started, signal?: AbortSignal): Promise<Confirmed> {
  const tokens = await CloudOidc.waitForTokens(started.discovery, started.clientID, started.device, { signal })
  const user = await CloudOidc.user(started.discovery, tokens)
  return { ...started, tokens, user }
}

/**
 * Whether Lunos waits for the address to be confirmed, where the provider says it isn't: for its own
 * accounts, and for the account the TUI's Welcome screen asks for (`always`). An organisation's
 * provider decides for itself, so `lunos login` to one doesn't wait.
 */
export function unverified(confirmed: Pick<Confirmed, "issuer" | "user">, always = false) {
  return (always || CloudHosted.lunosIssuer(confirmed.issuer)) && confirmed.user.email_verified === false
}

export const where = (backend: CloudStore.Backend) =>
  backend === "keychain"
    ? "the macOS Keychain"
    : backend === "secret-service"
      ? "the system keyring"
      : backend === "test-keychain"
        ? "the test keychain"
        : "a file only you can read"

/**
 * Session sync's part of a sign-in (XCOD-185), after it is stored: register this device and show
 * the first-sync notice once. Only for Lunos's own issuer, or with `cloud.endpoint` set explicitly:
 * an organisation's token isn't sent to Lunos Cloud by default.
 */
export async function loginSync(input: {
  issuer: string
  locked: boolean
  print: (line: string) => void
  opts?: CloudSyncApi.Options
}) {
  if (!(await CloudSyncApi.permitted(input.issuer))) return input.print(CloudSyncApi.NEEDS_ENDPOINT)
  const state = await CloudSyncApi.register({ timeoutMs: 5_000, ...input.opts }).catch((error) => {
    input.print(`Session sync isn't set up: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })
  if (state) await CloudSyncApi.notice(state, input.locked, input.print)
}

/**
 * Keeps the session and does what follows a sign-in. Registering the device and looking up the hosted
 * organisation never fail the sign-in: their problems are printed.
 */
export async function keep(
  confirmed: Confirmed,
  input: {
    syncLocked: boolean
    print: (line: string) => void
    /**
     * XCOD-273: false for the sign-in Lunos asks for at start (Welcome screen, line mode): that one
     * mustn't turn session sync on by itself. `lunos sync on` (or `lunos login`) does.
     */
    sync?: boolean
  },
) {
  const backend = await CloudStore.save({
    issuer: confirmed.issuer,
    clientID: confirmed.clientID,
    tokens: confirmed.tokens,
    email: confirmed.user.email,
    sub: confirmed.user.sub,
    savedAt: new Date().toISOString(),
  })
  if (input.sync !== false)
    await loginSync({ issuer: confirmed.issuer, locked: input.syncLocked, print: input.print }).catch((error) =>
      input.print(`Session sync isn't set up: ${error instanceof Error ? error.message : String(error)}`),
    )
  // XCOD-242: team features for the account's hosted organisation, unless managed config decides
  // (it sets cloud.policy, or cloud.auto_team: false): then nothing is looked up.
  const hosted = await (async () => {
    const onDisk = await ConfigManaged.readOnDiskDocs().catch(() => [] as unknown[])
    if (ConfigOrgPolicy.policyURL(onDisk) || ConfigOrgPolicy.autoTeamOff(onDisk)) {
      await CloudHosted.clear()
      return { kind: "none" } as const
    }
    return CloudHosted.afterLogin({ issuer: confirmed.issuer, sub: confirmed.user.sub, tokens: confirmed.tokens })
  })()
  const line = CloudHosted.describe(hosted)
  if (line) input.print(line)
  return { backend, hosted }
}

/** Signs out here: revokes the refresh token where the provider allows it, then forgets the session. */
export async function logout() {
  const session = await CloudStore.load()
  if (!session || session.fromEnv) return { session, revoked: false }
  // Revoke first, so the refresh token stops working even if a copy exists somewhere.
  const revoked = await CloudOidc.discover(session.issuer)
    .then((discovery) => CloudOidc.revoke(discovery, session.clientID, session.tokens))
    .catch(() => false)
  await CloudStore.clear()
  await CloudHosted.clear()
  return { session, revoked }
}

/** What a failed step means for the person signing in. Classified by the error's code, never its text. */
export function classify(error: unknown): FailureKind {
  const code = error instanceof CloudOidc.OidcError ? error.code : undefined
  switch (code) {
    case "expired_token":
      return "expired"
    case "access_denied":
      return "denied"
    case "offline":
      return "offline"
    case "unreachable":
      return "unreachable"
  }
  return "other"
}
