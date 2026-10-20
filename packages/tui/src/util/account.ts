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
export type FailureKind = "expired" | "denied" | "offline" | "unreachable" | "unverified" | "unavailable" | "other"

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
  /** The plan the account is on, when Lunos Cloud says (`Free`, `Lunos Pro`, …). */
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
  /** Sends the confirmation e-mail again; AccountError("unavailable") where the service can't yet. */
  resend(): Promise<void>
  /** Keeps the session (keychain) and does what `lunos login` does after it. */
  save(): Promise<SignedIn>
}

export type Organisation = { org: string; role?: string }
export type Device = { id: string; name: string; platform?: string; current?: boolean; revoked?: boolean }

/** What /account shows. A part Lunos Cloud doesn't serve yet says so instead of being made up. */
export type Details = {
  user: SignedIn
  /** `lunos_platform_role` from the access token, when present. */
  platformRole?: string
  organisations?: Organisation[]
  devices?: Device[]
  /** Parts not shown, and why (offline, another issuer, not served yet). */
  missing: string[]
}

export type Legal = {
  /** The version of the Terms and Privacy notice this build asks to accept. */
  version: string
  terms: string
  privacy: string
}

export type Host = {
  gate: Gate
  legal: Legal
  /** Who is signed in, from the stored session only: no network. */
  current(): Promise<SignedIn | undefined>
  /**
   * Refreshes the stored session when it is due and the provider can be reached. Returns "expired"
   * when the provider refused the refresh (signed out elsewhere, revoked), "ok" otherwise, offline
   * included: the cached sign-in holds.
   */
  refresh(): Promise<"ok" | "expired" | "none">
  /** The Terms version this account last accepted on this machine. */
  accepted(): Promise<string | undefined>
  accept(version: string): Promise<void>
  /** Whether the sign-in service can be reached; "offline" at start means the one-time offline exemption. */
  probe(): Promise<"ok" | FailureKind>
  start(input: { signup: boolean }): Promise<DeviceFlow>
  /** Opens the browser; false when it couldn't. */
  open(url: string): Promise<boolean>
  logout(): Promise<{ revoked: boolean }>
  details(): Promise<Details>
  /** Ends every session of this account at the provider, then signs out here. */
  logoutEverywhere(): Promise<{ ended: boolean; message?: string }>
  /** Asks Lunos Cloud to delete the account, then signs out here. */
  deleteAccount(): Promise<{ message: string }>
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
    case "other":
      return {
        title: "Sign-in failed",
        why: message,
        fix: "Try again. If it keeps failing, run lunos login to see more.",
      }
  }
}

/** Whether a new Terms version (or none accepted yet) means asking again. */
export function needsAcceptance(legal: Legal, accepted: string | undefined) {
  return accepted !== legal.version
}
