export * as CloudBeta from "./beta"

import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Offline } from "@opencode-ai/core/offline"
import { CloudAccountApi } from "./account-api"
import { CloudAuth } from "./auth"
import { CloudStore } from "./store"

/**
 * XCOD-318: the private beta, on Lunos Cloud's control plane (lunoshq), with the session's own token:
 *
 *   POST /v1/account/redeem    { code }: admits the account to Lunos Cloud, tags its beta cohort and
 *                              grants the code's plan (`lunos cloud redeem <code>`)
 *   POST /v1/account/feedback  /feedback in the TUI, the desktop and web app's Feedback button
 *
 * Feedback is the text the person wrote, an optional screenshot they attached, this client's version
 * and OS, and the current session's id only when they ticked the box to share it (`consent`). Never a
 * transcript: `body` below is the whole request, built from those fields alone. Lunos Cloud drops a
 * session id sent without consent too.
 */

export class BetaError extends Error {
  override name = "CloudBetaError"
}

export type Source = "tui" | "cli" | "app" | "desktop"

export type Feedback = {
  text: string
  source: Source
  /** The person ticked "share this session's id". Without it no session id leaves the machine. */
  consent: boolean
  sessionId?: string
  /** PNG, JPEG or WebP, base64; at most 2 MB decoded. */
  screenshot?: { type: string; data: string }
  /** Defaults: this build's version, and the OS it runs on. */
  version?: string
  os?: string
}

export const MAX_TEXT = 5000

/** The request body: only these fields, and `sessionId` only with consent. */
export function body(input: Feedback) {
  const text = input.text.trim()
  return {
    text,
    source: input.source,
    version: input.version ?? InstallationVersion,
    os: input.os ?? `${process.platform} ${process.arch}`,
    consent: input.consent === true,
    ...(input.consent === true && input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.screenshot ? { screenshot: { type: input.screenshot.type, data: input.screenshot.data } } : {}),
  }
}

export type Options = CloudAccountApi.Options & {
  /** Tests: skip the stored session. */
  session?: { token: string; issuer: string }
}

async function token(what: string, opts: Options) {
  if (Offline.enabled()) throw new BetaError(Offline.message(what))
  const session = opts.session ?? (await signedIn(what))
  const refused = await CloudAccountApi.allowed(session.issuer)
  if (refused) throw new BetaError(`${what} needs a Lunos account: ${refused}.`)
  return session.token
}

async function signedIn(what: string) {
  const stored = await CloudStore.load()
  if (!stored) throw new BetaError("Not signed in. Run lunos login first.")
  // Refreshed (with discovery) only when it's about to expire, as for git tokens.
  const expires = stored.tokens.expires_at
  if (expires === undefined || expires * 1000 > Date.now() + 30_000)
    return { token: stored.tokens.access_token, issuer: stored.issuer }
  const fresh = await CloudAuth.session(what)
  return { token: fresh.tokens.access_token, issuer: stored.issuer }
}

const failed = (error: unknown): never => {
  if (error instanceof BetaError) throw error
  if (error instanceof CloudAccountApi.NotServedError)
    throw new BetaError("This Lunos Cloud doesn't take beta codes or feedback yet.")
  // Lunos Cloud's own words for the beta codes (code_expired, code_used_up, …): they say what to do.
  if (error instanceof CloudAccountApi.RefusedError) throw new BetaError(error.serverMessage ?? error.message)
  throw new BetaError(error instanceof Error ? error.message : String(error))
}

export type Redeemed = { cohort: string; plan?: { plan: string; until: string }; planNotGranted?: string }

export async function redeem(code: string, opts: Options = {}): Promise<Redeemed> {
  const trimmed = code.trim()
  if (!trimmed) throw new BetaError("Give the beta code you were sent: lunos cloud redeem LUNOS-…")
  const access = await token("Redeeming a beta code", opts)
  const result = (await CloudAccountApi.call(
    access,
    "POST",
    "/v1/account/redeem",
    { code: trimmed },
    "Redeeming a beta code",
    opts,
  ).catch(failed)) as Record<string, unknown> | undefined
  const plan = result?.plan as { plan?: unknown; until?: unknown } | undefined
  return {
    cohort: String(result?.cohort ?? ""),
    ...(plan && typeof plan.plan === "string" && typeof plan.until === "string"
      ? { plan: { plan: plan.plan, until: plan.until } }
      : {}),
    ...(typeof result?.planNotGranted === "string" ? { planNotGranted: result.planNotGranted } : {}),
  }
}

/** What `lunos cloud redeem` and the TUI say after a code was redeemed. */
export function redeemedText(r: Redeemed) {
  const plan = r.plan
    ? ` Lunos ${r.plan.plan[0]!.toUpperCase()}${r.plan.plan.slice(1)} is yours until ${r.plan.until.slice(0, 10)}.`
    : r.planNotGranted
      ? ` ${r.planNotGranted}`
      : ""
  return `You're in the Lunos Cloud beta.${plan}`
}

export async function feedback(input: Feedback, opts: Options = {}) {
  const payload = body(input)
  if (!payload.text) throw new BetaError("Write what you'd like to tell us first.")
  if (payload.text.length > MAX_TEXT) throw new BetaError(`Feedback is at most ${MAX_TEXT} characters.`)
  const access = await token("Sending feedback", opts)
  const result = (await CloudAccountApi.call(access, "POST", "/v1/account/feedback", payload, "Sending feedback", {
    timeoutMs: 30_000,
    ...opts,
  }).catch(failed)) as Record<string, unknown> | undefined
  return { id: String(result?.id ?? ""), sessionShared: result?.sessionShared === true }
}
