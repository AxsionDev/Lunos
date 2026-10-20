export * as CloudAuth from "./auth"

import { CloudOidc } from "./oidc"
import { CloudStore } from "./store"

export class SignedOutError extends Error {
  override name = "CloudSignedOut"
  constructor(what = "This") {
    super(
      `${what} needs a Lunos Cloud sign-in. Run lunos login, or set ${CloudStore.TOKEN_ENV} where nobody can sign in (CI).`,
    )
  }
}

/**
 * The stored session, its access token refreshed first if it expires within 30 s (and the refresh
 * saved). Throws SignedOutError when nobody is signed in. `force` refreshes whatever the expiry says:
 * a server answered 401 to a token that looked current. The provider is only asked (discovery) when
 * a refresh is needed, so a current token costs no call.
 *
 * XCOD-273: with nothing stored, `LUNOS_TOKEN` is the session (CI and headless runs, where the TUI's
 * sign-in can't run). It is used as is: it can't be refreshed, so an expired one fails with a message
 * that names it.
 */
export async function session(what?: string, opts: { force?: boolean } = {}) {
  const stored = await CloudStore.load()
  if (!stored) throw new SignedOutError(what)
  const stale =
    opts.force || (stored.tokens.expires_at !== undefined && stored.tokens.expires_at * 1000 < Date.now() + 30_000)
  if (!stale) return { ...stored, discovery: undefined as CloudOidc.Discovery | undefined }
  if (stored.fromEnv)
    throw new CloudOidc.OidcError(`${CloudStore.TOKEN_ENV} has expired or was refused; set a fresh one`, "expired_env")
  const discovery = await CloudOidc.discover(stored.issuer)
  const tokens = await CloudOidc.refresh(discovery, stored.clientID, stored.tokens)
  await CloudStore.save({ ...stored, tokens, savedAt: new Date().toISOString() })
  return { ...stored, tokens, discovery: discovery as CloudOidc.Discovery | undefined }
}
