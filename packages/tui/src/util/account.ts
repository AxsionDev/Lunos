// XCOD-273: the Lunos account in the TUI. The sign-in itself runs in the CLI process (the same device
// flow, token store and refresh as `lunos login`); the TUI gets it as a host, like /restart's, so the
// server and the SDK carry no account endpoints.

/** Why the Welcome screen is skipped. Each makes no call to Lunos's sign-in or account services. */
export type Exemption = "source-build" | "managed" | "org-issuer" | "offline" | "no-network" | "ci" | "headless"

export const EXEMPTION_TEXT: Record<Exemption, string> = {
  "source-build": "built from source: sign-in isn't required",
  managed: "your organisation's managed config sets auth.required: false",
  "org-issuer": "your organisation signs you in with its own identity provider (cloud.issuer)",
  offline: "offline mode (LUNOS_OFFLINE)",
  "no-network": "no network at start",
  ci: "CI (CI=true)",
  headless: "not an interactive terminal",
}

export type Gate = { required: true; issuer: string } | { required: false; exemption: Exemption; issuer?: string }

/** Why a sign-in step failed. Each kind has its own message and a Try again. */
export type FailureKind =
  | "expired"
  | "denied"
  | "offline"
  | "unreachable"
  | "unverified"
  | "unavailable"
  | "rate_limited"
  | "other"

export class AccountError extends Error {
  override name = "AccountError"
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message)
  }
}

export function failureKind(error: unknown): FailureKind {
  return error instanceof AccountError ? error.kind : "other"
}

export type SignedIn = {
  sub: string
  email?: string
  name?: string
  issuer: string
  /** Where the session is kept: "the macOS Keychain", "the system keyring", … */
  kept?: string
  /** The plan the account is on, when Lunos Cloud says (`Free`, `Pro`, …): `GET /v1/account`, never billing. */
  plan?: string
  /** Lines `lunos login` prints after signing in: session sync, team features. */
  notes?: string[]
}

/** The device code to confirm, and what happens next. */
export type DeviceFlow = {
  userCode: string
  /** Where to confirm the code. */
  url: string
  /** The same page with the code filled in, when the provider offers one (also the QR code's target). */
  urlComplete?: string
  /** Milliseconds since the epoch. */
  expiresAt: number
  /** Polls until the browser confirms it; throws AccountError (expired, denied, offline…) otherwise. */
  wait(signal: AbortSignal): Promise<Pending>
}

/** Confirmed in the browser, not yet kept: the e-mail address may still need confirming. */
export type Pending = {
  email?: string
  verified: boolean
  /** Asks the provider again whether the address is confirmed. */
  recheck(): Promise<boolean>
  /**
   * Sends the confirmation e-mail again; AccountError("rate_limited") when it was sent too recently,
   * with when to try again, and AccountError("unavailable") where the service can't yet.
   */
  resend(): Promise<void>
  /** Keeps the session (keychain) and does what `lunos login` does after it. */
  save(): Promise<SignedIn>
}

/** XCOD-274: an organisation and your role in it ("owner", "admin", "member"), as Lunos Cloud says. */
export type Organisation = { org: string; name?: string; role?: string; suspended?: boolean }
export type Device = { id: string; name: string; platform?: string; current?: boolean; revoked?: boolean }
/** An invitation to join an organisation, waiting for you to accept or decline it. */
export type Invitation = { org: string; name: string; role?: string; expiresAt?: number }

/** What /account shows. A part Lunos Cloud doesn't serve yet says so instead of being made up. */
export type Details = {
  user: SignedIn
  /** "user" or "global_admin": Lunos Cloud's record, or else the token's `lunos_platform_role` claim. */
  platformRole?: string
  organisations?: Organisation[]
  invitations?: Invitation[]
  devices?: Device[]
  /** Parts not shown, and why (offline, another issuer, not served yet). */
  missing: string[]
}

/** The Terms and the Privacy notice versions, as accepted or asked for. */
export type Versions = { terms: string; privacy: string }

/** XCOD-274: the Terms and Privacy notice versions Lunos Cloud asks this account to accept. */
export type TermsCheck = { current: Versions; accepted?: Versions }

/** What deleting the account came to: done, or refused (the last owner of an organisation) and why. */
export type Deletion = { deleted: true; message: string } | { deleted: false; title: string; message: string }

/** XCOD-275: the Terms and the Privacy notice the sign-up box accepts, as Lunos Cloud publishes them. */
export type Legal = { terms: { version: string; url: string }; privacy: { version: string; url: string } }

export const versions = (legal: Legal): Versions => ({ terms: legal.terms.version, privacy: legal.privacy.version })

/**
 * XCOD-312: why Lunos Cloud disabled the account, as a category (never its free-text reason). An
 * older server sends none.
 */
export type DisabledCategory = "abuse" | "security" | "terms" | "payment" | "offboarding" | "other"

export const DISABLED_CATEGORY_TEXT: Record<DisabledCategory, string> = {
  abuse: "Abuse or misuse of the service",
  security: "A security concern",
  terms: "A breach of the terms of service",
  payment: "A payment issue",
  offboarding: "Your organisation offboarded you",
  other: "Other",
}

export const SUPPORT_EMAIL = "support@lunos.tech"

/** XCOD-312: the account is disabled. `until` (ISO-8601) when it ends by itself; none: until lifted. */
export type Disabled = { category?: DisabledCategory; until?: string }

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10)

/** "Reason: A payment issue", "Until 2026-12-01", the support address: what the screen says under its title. */
export function disabledLines(disabled: Disabled) {
  return [
    ...(disabled.category ? [`Reason: ${DISABLED_CATEGORY_TEXT[disabled.category]}`] : []),
    ...(disabled.until ? [`Until ${day(disabled.until)}`] : []),
    `Contact support: ${SUPPORT_EMAIL}`,
  ]
}

export const DISABLED_TITLE = "Your Lunos account is disabled"

/** One line, where the prompt's placeholder would be: why it can't be used, and whom to ask. */
export function disabledNotice() {
  return `${DISABLED_TITLE}: new prompts can't be sent; past sessions stay readable. Contact support: ${SUPPORT_EMAIL}`
}

export type Host = {
  gate: Gate
  /**
   * XCOD-275: the current Terms and Privacy notice (`GET /v1/legal`), else the last ones kept on this
   * machine. With an exemption only the kept ones, unless the person asked to sign in (`asked`);
   * offline, always only the kept ones; with `cached`, only the kept ones. Undefined when there are none.
   */
  legal(input?: { asked?: boolean; cached?: boolean }): Promise<Legal | undefined>
  /** Who is signed in, from the stored session only: no network. */
  current(): Promise<SignedIn | undefined>
  /**
   * Refreshes the stored session when it is due and the provider can be reached. Returns "expired"
   * when the provider refused the refresh (signed out elsewhere, revoked), "ok" otherwise, offline
   * included: the cached sign-in holds. XCOD-312: "disabled" when the account turned out disabled.
   */
  refresh(): Promise<"ok" | "expired" | "none" | "disabled">
  /**
   * XCOD-312: whether Lunos Cloud (or the sign-in service) last said this account is disabled, from
   * this machine's record only: no network. Cleared by a successful sign-in or refresh.
   */
  disabled?(): Promise<Disabled | undefined>
  /** The Terms and Privacy notice versions this account last accepted on this machine. */
  accepted(): Promise<Versions | undefined>
  /**
   * Records the acceptance on this machine, and at Lunos Cloud when it asked for `server`'s versions
   * (it refuses any but its current ones); throws when Lunos Cloud couldn't record them.
   */
  accept(accepted: Versions, server?: Versions): Promise<void>
  /**
   * XCOD-274: whether Lunos Cloud records an older acceptance than its current Terms and Privacy
   * notice (or none it can match to this machine's), so the account is asked again. Undefined when
   * nothing is to accept, or Lunos Cloud can't be asked (offline, an organisation's sign-in).
   */
  termsCheck?(): Promise<TermsCheck | undefined>
  /** Whether the sign-in service can be reached; "offline" at start means the one-time offline exemption. */
  probe(): Promise<"ok" | FailureKind>
  start(input: { signup: boolean }): Promise<DeviceFlow>
  /** Opens the browser; false when it couldn't. */
  open(url: string): Promise<boolean>
  logout(): Promise<{ revoked: boolean }>
  details(): Promise<Details>
  /** Ends every session of this account at the provider, then signs out here. */
  logoutEverywhere(): Promise<{ ended: boolean; message?: string }>
  /** Asks Lunos Cloud to delete the account, then signs out here; not when it refuses. */
  deleteAccount(): Promise<Deletion>
  /** XCOD-274: accepts or declines an invitation to an organisation; says what happened. */
  answerInvitation?(org: string, accept: boolean): Promise<string>
}

/** "p…@example.com": enough to recognise the address on a shared screen. */
export function maskEmail(email: string | undefined) {
  if (!email) return undefined
  const at = email.indexOf("@")
  if (at <= 0) return email
  return `${email[0]}…${email.slice(at)}`
}

/** "4:59" for a countdown. */
export function countdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** One line for who is signed in: "Signed in as name@example.com · Plan: Free". */
export function signedInLine(user: SignedIn) {
  const who = user.email ?? user.name ?? user.sub
  return `Signed in as ${who}${user.plan ? ` · Plan: ${user.plan}` : ""}`
}

/** What each failure says, and what to do about it. The style of the memory check's errors (XCOD-263). */
export function failureText(kind: FailureKind, message: string): { title: string; why: string; fix: string } {
  switch (kind) {
    case "expired":
      return {
        title: "The sign-in code expired",
        why: "It wasn't confirmed in the browser in time.",
        fix: "Try again for a new code.",
      }
    case "denied":
      return {
        title: "The sign-in was denied",
        why: "The request was turned down on the sign-in page.",
        fix: "Try again, and choose Yes on the page if it was you.",
      }
    case "offline":
      return {
        title: "You're offline",
        why: "This computer couldn't look up the sign-in service.",
        fix: "Check your connection, then Try again. Or continue offline and sign in later with /login.",
      }
    case "unreachable":
      return {
        title: "The sign-in service can't be reached",
        why: message,
        fix: "Try again in a moment. If it keeps failing, check a proxy or firewall, or status.lunos.tech.",
      }
    case "unverified":
      return {
        title: "Your e-mail address isn't confirmed yet",
        why: "Lunos needs a confirmed address before your account can be used.",
        fix: "Open the link in the e-mail we sent, then Try again. Resend sends a new one.",
      }
    case "unavailable":
      return { title: "Not available yet", why: message, fix: "Use the link on the sign-in page instead." }
    case "rate_limited":
      return { title: "Sent too recently", why: message, fix: "Check your inbox and spam folder in the meantime." }
    case "other":
      return {
        title: "Sign-in failed",
        why: message,
        fix: "Try again. If it keeps failing, run lunos login to see more.",
      }
  }
}

/** "Owner · Acme GmbH": your role in an organisation, for /account (XCOD-274). */
export function organisationLine(item: Organisation) {
  const role = item.role ? item.role[0]!.toUpperCase() + item.role.slice(1) : undefined
  const name = item.name ?? item.org
  return `${role ? `${role} · ` : ""}${name}${item.suspended ? " (suspended)" : ""}`
}

/** "Global Admin" for Lunos platform staff; "User" for everyone else. */
export function platformRoleText(role: string) {
  if (role === "global_admin") return "Global Admin"
  if (role === "user") return "User"
  return role
}

/**
 * Whether a new Terms or Privacy notice version (or none accepted yet) means asking again. Not when
 * the current ones aren't known (offline with nothing kept): the start doesn't wait on them.
 */
export function needsAcceptance(legal: Legal | undefined, accepted: Versions | undefined) {
  if (!legal) return false
  return accepted?.terms !== legal.terms.version || accepted?.privacy !== legal.privacy.version
}
