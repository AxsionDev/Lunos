export * as CloudAuth from "./auth"

import { CloudOidc } from "./oidc"
import { CloudStore } from "./store"

export class SignedOutError extends Error {
  override name = "CloudSignedOut"
  constructor(what = "This") {
    super(`${what} needs a Lunos Cloud sign-in. Run lunos login.`)
  }
}

/**
 * The stored session, its access token refreshed first if it expires within 30 s (and the refresh
 * saved). Throws SignedOutError when nobody is signed in; nothing else in Lunos asks for a sign-in.
 */
export async function session(what?: string) {
  const stored = await CloudStore.load()
  if (!stored) throw new SignedOutError(what)
  const discovery = await CloudOidc.discover(stored.issuer)
  let tokens = stored.tokens
  if (tokens.expires_at !== undefined && tokens.expires_at * 1000 < Date.now() + 30_000) {
    tokens = await CloudOidc.refresh(discovery, stored.clientID, tokens)
    await CloudStore.save({ ...stored, tokens, savedAt: new Date().toISOString() })
  }
  return { ...stored, tokens, discovery }
}
