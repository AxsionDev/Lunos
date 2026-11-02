export * as CloudAuth from "./auth"

import { Offline } from "@opencode-ai/core/offline"
import { CloudDisabled } from "./disabled"
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
  const tokens = await CloudOidc.refresh(discovery, stored.clientID, stored.tokens).catch(async (error: unknown) => {
    const disabled = await refusedBecauseDisabled(error, stored)
    if (!disabled) throw error
    await CloudDisabled.record(disabled).catch(() => undefined)
    throw new CloudDisabled.DisabledError(disabled)
  })
  await CloudStore.save({ ...stored, tokens, savedAt: new Date().toISOString() })
  await lifted(stored, tokens.access_token).catch(() => undefined)
  return { ...stored, tokens, discovery: discovery as CloudOidc.Discovery | undefined }
}

/**
 * XCOD-312: after a refresh that went through, whether a disabled record still holds. The sign-in
 * service letting the session go on doesn't say Lunos Cloud lifted it (it may disable the account
 * there first), so where Lunos Cloud may be asked, one `GET /v1/account` decides: answered, the
 * record goes; refused as suspended, the call records it again; unreachable, it stays. Nothing is
 * asked when there's no record.
 */
async function lifted(stored: CloudStore.Session, token: string) {
  if (!(await CloudDisabled.load())) return
  const { CloudAccountApi } = await import("./account-api")
  if (await CloudAccountApi.allowed(stored.issuer)) return CloudDisabled.clear()
  await CloudAccountApi.account(token, { timeoutMs: 5_000 }).then(
    () => CloudDisabled.clear(),
    () => undefined,
  )
}

/**
 * XCOD-312: whether a refused refresh means the account is disabled. Keycloak says so ("Account
 * disabled") when the user is disabled; once it has also ended the sessions it says only "Session not
 * active", like any expired session. Then, while the access token is still current (Keycloak's live 5
 * minutes), one `GET /v1/account` with it asks Lunos Cloud, where it may be asked at all (Lunos's own
 * issuer or a configured cloud.endpoint, never offline). Anything else stays a plain sign-out.
 */
export async function refusedBecauseDisabled(
  error: unknown,
  stored: CloudStore.Session,
  opts: { fetch?: typeof fetch } = {},
): Promise<CloudDisabled.Disabled | undefined> {
  if (!(error instanceof CloudOidc.OidcError) || error.code !== "invalid_grant") return undefined
  if (CloudDisabled.refreshSaysDisabled(error)) return {}
  const expires = stored.tokens.expires_at
  if (expires === undefined || expires * 1000 <= Date.now() || Offline.enabled()) return undefined
  // Imported here: the account API reaches this module through session sync.
  const { CloudAccountApi } = await import("./account-api")
  if (await CloudAccountApi.allowed(stored.issuer)) return undefined
  return CloudAccountApi.account(stored.tokens.access_token, { timeoutMs: 5_000, fetch: opts.fetch }).then(
    () => undefined,
    (refused: unknown) =>
      refused instanceof CloudAccountApi.RefusedError
        ? CloudDisabled.suspension(refused.status, {
            code: refused.code,
            legacyCode: refused.legacyCode,
            details: refused.details,
          })
        : undefined,
  )
}
