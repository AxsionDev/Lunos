export * as CloudTuiHost from "./tui-host"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { openUrl } from "@opencode-ai/core/open"
import {
  AccountError,
  type Details,
  type Deletion,
  type DeviceFlow,
  type Gate,
  type Host,
  type Legal,
  type Pending,
  type SignedIn,
  type TermsCheck,
  type TerminalCommand,
  type Versions,
} from "@opencode-ai/tui/util/account"
import { Offline } from "@opencode-ai/core/offline"
import { CloudAccountApi } from "./account-api"
import { CloudAuth } from "./auth"
import { CloudDisabled } from "./disabled"
import { CloudLegal } from "./legal"
import { CloudOidc } from "./oidc"
import { CloudSignin } from "./signin"
import { CloudStore } from "./store"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-273: the account host the TUI's Welcome screen, /login, /logout and /account use. It runs in
 * the CLI process, next to `lunos login`, and calls the same code (cloud/signin.ts). With an exemption
 * the TUI calls none of it, so no Lunos service is contacted.
 */

/** Where this machine remembers the accepted versions; Lunos Cloud keeps its own record (XCOD-274). */
export const consentFile = () => path.join(Global.Path.data, "cloud", "consent.json")

const fail = (error: unknown): never => {
  if (error instanceof AccountError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof CloudAccountApi.NotServedError) throw new AccountError("unavailable", message)
  if (error instanceof CloudAccountApi.RefusedError && error.status === 429)
    throw new AccountError("rate_limited", message)
  throw new AccountError(CloudSignin.classify(error), message)
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/** `lunos_platform_role` (XCOD-274): a string or a list, in the access token. Display only. */
function platformRole(token: string) {
  const value = CloudOidc.claims(token).lunos_platform_role
  if (Array.isArray(value)) return value.map(String).join(", ") || undefined
  return text(value)
}

async function signedIn(session: CloudStore.Session): Promise<SignedIn> {
  const claims = CloudOidc.claims(session.tokens.id_token)
  return {
    sub: session.sub,
    email: session.email,
    name: text(claims.name),
    issuer: session.issuer,
    kept: session.fromEnv ? CloudStore.TOKEN_ENV : CloudSignin.where(await CloudStore.backend()),
  }
}

const PLANS: Record<string, string> = { free: "Free", pro: "Pro", team: "Team", enterprise: "Enterprise" }
const planName = (id: string) => PLANS[id] ?? id[0]!.toUpperCase() + id.slice(1)

/**
 * XCOD-275: the plan line, from `GET /v1/account` (`plan`, `plan_source`): "Free", or "Team (Acme
 * GmbH's)" for an organisation's plan. Never a billing call. Undefined where Lunos Cloud doesn't say.
 */
export function plan(account: CloudAccountApi.Account) {
  if (!account.plan) return undefined
  const source = account.planSource
  if (!source || source === "personal") return planName(account.plan)
  const org = account.organizations.find((item) => item.org === source)
  return `${planName(account.plan)} (${org?.name ?? source}'s)`
}

/** The plan for the sign-in line: one `GET /v1/account`, where Lunos Cloud may be asked; never fails the sign-in. */
async function signInPlan(confirmed: CloudSignin.Confirmed) {
  if (await CloudAccountApi.allowed(confirmed.issuer)) return undefined
  return CloudAccountApi.account(confirmed.tokens.access_token, { timeoutMs: 5_000 }).then(plan, () => undefined)
}

function pending(confirmed: CloudSignin.Confirmed, strict: boolean): Pending {
  let state = confirmed
  return {
    email: confirmed.user.email,
    verified: !CloudSignin.unverified(confirmed, strict),
    async recheck() {
      const user = await CloudOidc.user(state.discovery, state.tokens).catch(fail)
      state = { ...state, user }
      return !CloudSignin.unverified(state, strict)
    },
    async resend() {
      const refused = await CloudAccountApi.allowed(state.issuer)
      if (refused) throw new AccountError("unavailable", `Can't ask Lunos Cloud: ${refused}.`)
      await CloudAccountApi.resendVerification(state.tokens.access_token).catch(fail)
    },
    async save() {
      if (CloudSignin.unverified(state, strict))
        throw new AccountError("unverified", "The e-mail address isn't confirmed yet.")
      const notes: string[] = []
      const kept = await CloudSignin.keep(state, { syncLocked: false, sync: false, print: (line) => notes.push(line) })
      // The box ticked before the sign-in was remembered then (accept); Lunos Cloud is told after this,
      // by the start's Terms check (termsCheck).
      return {
        sub: state.user.sub,
        email: state.user.email,
        name: state.user.name,
        issuer: state.issuer,
        kept: CloudSignin.where(kept.backend),
        plan: await signInPlan(state),
        notes,
      }
    },
  }
}

/** The accepted versions, on this machine. */
async function remember(accepted: Versions) {
  const where = consentFile()
  await fs.mkdir(path.dirname(where), { recursive: true, mode: 0o700 })
  await fs.writeFile(where, JSON.stringify({ ...accepted, at: new Date().toISOString() }), { mode: 0o600 })
}

async function accepted(): Promise<Versions | undefined> {
  const raw = await fs.readFile(consentFile(), "utf8").catch(() => undefined)
  if (!raw) return undefined
  try {
    const stored = JSON.parse(raw) as { terms?: unknown; privacy?: unknown; version?: unknown }
    const terms = text(stored.terms)
    const privacy = text(stored.privacy)
    if (terms && privacy) return { terms, privacy }
    // Before XCOD-275 one version stood for both.
    const version = text(stored.version)
    return version ? { terms: version, privacy: version } : undefined
  } catch {
    return undefined
  }
}

/** The stored session's fresh token, when Lunos Cloud may be asked; undefined otherwise. */
async function cloudToken(what: string) {
  const session = await CloudStore.load()
  if (!session || (await CloudAccountApi.allowed(session.issuer))) return undefined
  return (await CloudAuth.session(what)).tokens.access_token
}

/**
 * XCOD-274: Lunos Cloud's record of the accepted Terms and Privacy notice (`GET /v1/account`). Asks
 * again when it records an older version than its current one. When it records none, and the
 * version accepted on this machine is exactly its current one (the box ticked at sign-in), that
 * acceptance is sent (`PUT /v1/account/terms`) instead of asking twice. Nothing is asked when Lunos
 * Cloud can't be reached or doesn't serve the record yet: the start never waits on it.
 */
async function termsCheck(): Promise<TermsCheck | undefined> {
  const token = await cloudToken("Checking the Terms").catch(() => undefined)
  if (!token) return undefined
  const terms = await CloudAccountApi.account(token, { timeoutMs: 5_000 })
    .then((account) => account.terms)
    .catch(() => undefined)
  if (!terms?.needsAcceptance) return undefined
  const check = { current: terms.current, accepted: terms.accepted }
  const local = await accepted()
  if (terms.accepted || local?.terms !== terms.current.terms || local?.privacy !== terms.current.privacy) return check
  return CloudAccountApi.acceptTerms(token, terms.current, { timeoutMs: 5_000 }).then(
    () => undefined,
    // Refused: ask, so the acceptance it records is one the user gave. Unreachable: the next start asks.
    (error: unknown) => (error instanceof CloudAccountApi.RefusedError ? check : undefined),
  )
}

const ROLE_TEXT: Record<string, string> = { owner: "an owner", admin: "an admin", member: "a member" }

export function create(input: { gate: Gate; issuer: string; clientID: string }): Host {
  return {
    gate: input.gate,
    async legal(ask): Promise<Legal | undefined> {
      // An exemption contacts no Lunos service at start; /login (asked) does, where Lunos Cloud may be
      // asked at all (not for an organisation's issuer without cloud.endpoint).
      const network =
        !ask?.cached &&
        (input.gate.required || ask?.asked === true) &&
        (await CloudSyncApi.permitted(input.issuer).catch(() => false))
      return CloudLegal.current({ network, timeoutMs: input.gate.required && !ask?.asked ? 3_000 : undefined })
    },
    async current() {
      const session = await CloudStore.load()
      return session ? signedIn(session) : undefined
    },
    async refresh() {
      const session = await CloudStore.load()
      if (!session) return "none"
      return CloudAuth.session()
        .then(() => "ok" as const)
        .catch((error) => {
          // XCOD-312: the refresh found the account disabled (and recorded it).
          if (error instanceof CloudDisabled.DisabledError) return "disabled" as const
          // Offline, or the provider is down: the cached sign-in holds until it can be checked.
          const kind = CloudSignin.classify(error)
          return kind === "offline" || kind === "unreachable" ? ("ok" as const) : ("expired" as const)
        })
    },
    async disabled() {
      return CloudDisabled.load()
    },
    accepted,
    async accept(versions, server) {
      if (server) {
        const token = await cloudToken("Recording your acceptance of the Terms").catch(fail)
        if (token) await CloudAccountApi.acceptTerms(token, server).catch(fail)
      }
      await remember(versions)
    },
    termsCheck,
    async probe() {
      return CloudOidc.discover(input.issuer)
        .then(() => "ok" as const)
        .catch((error: unknown) => CloudSignin.classify(error))
    },
    async start(): Promise<DeviceFlow> {
      const started = await CloudSignin.begin({ issuer: input.issuer, clientID: input.clientID }).catch(fail)
      return {
        userCode: started.device.user_code,
        url: started.device.verification_uri,
        urlComplete: started.device.verification_uri_complete,
        expiresAt: Date.now() + started.device.expires_in * 1000,
        wait: async (signal) =>
          pending(
            await CloudSignin.complete(started, signal).catch(fail),
            // The account the Welcome screen asks for needs a confirmed address; an organisation's doesn't.
            !(input.gate.required === false && input.gate.exemption === "org-issuer"),
          ),
      }
    },
    async open(url) {
      return openUrl(url)
        .then(() => true)
        .catch(() => false)
    },
    async logout() {
      const { revoked } = await CloudSignin.logout()
      return { revoked }
    },
    async details(): Promise<Details> {
      const session = await CloudStore.load()
      if (!session) throw new AccountError("other", "Not signed in.")
      const user = await signedIn(session)
      const missing: string[] = []
      const details: Details = { user, platformRole: platformRole(session.tokens.access_token), missing }
      const refused = await CloudAccountApi.allowed(session.issuer)
      if (refused) {
        // An organisation's sign-in: what its token says, and nothing is asked of Lunos Cloud.
        const claimed = CloudOidc.claims(session.tokens.access_token).organization
        if (Array.isArray(claimed)) details.organisations = claimed.map((org) => ({ org: String(org) }))
        missing.push(`Plan and devices aren't shown: ${refused}.`)
        return details
      }
      const fresh = await CloudAuth.session("Your account").catch(fail)
      const account = await CloudAccountApi.account(fresh.tokens.access_token).catch((error) => {
        missing.push(
          `Lunos Cloud couldn't be asked for your plan, organisations and devices: ${error instanceof Error ? error.message : String(error)}`,
        )
        return undefined
      })
      if (!account) return details
      const device = (await CloudSyncApi.load())?.device.id
      // Lunos Cloud's record decides the role; the token's claim is only a fallback (it grants nothing).
      if (account.platformRole) details.platformRole = account.platformRole
      details.organisations = account.organizations
      details.invitations = await CloudAccountApi.invitations(fresh.tokens.access_token).catch((error: unknown) => {
        if (!(error instanceof CloudAccountApi.NotServedError))
          missing.push(`Invitations: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      details.devices = account.devices.map((item) => ({
        id: item.id,
        name: item.name,
        platform: item.platform,
        current: item.id === device,
        revoked: item.revokedAt !== undefined,
      }))
      user.plan = plan(account)
      if (!user.plan) missing.push("Plan: this Lunos Cloud doesn't report it yet.")
      return details
    },
    async logoutEverywhere() {
      const session = await CloudStore.load()
      if (!session) return { ended: false, message: "Not signed in." }
      // Keycloak's account API ends every session of the account (the other devices' included).
      const ended = await CloudAuth.session("Signing out everywhere")
        .then(async (fresh) => {
          const response = await fetch(`${fresh.issuer.replace(/\/+$/, "")}/account/sessions`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${fresh.tokens.access_token}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(CloudOidc.TIMEOUT_MS),
          })
          return response.ok ? undefined : `the sign-in service answered ${response.status}`
        })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      await CloudSignin.logout()
      return ended === undefined
        ? { ended: true }
        : { ended: false, message: `Signed out here, but other devices couldn't be signed out: ${ended}.` }
    },
    async deleteAccount(): Promise<Deletion> {
      const session = await CloudStore.load()
      if (!session) throw new AccountError("other", "Not signed in.")
      const refused = await CloudAccountApi.allowed(session.issuer)
      if (refused) throw new AccountError("unavailable", `Lunos Cloud can't be asked: ${refused}.`)
      const fresh = await CloudAuth.session("Deleting your account").catch(fail)
      const result = await CloudAccountApi.deleteAccount(fresh.tokens.access_token).catch(async (error: unknown) => {
        if (!(error instanceof CloudAccountApi.LastOwnerError)) return fail(error)
        // Nothing changed at Lunos Cloud: you stay signed in, and are told which organisations to hand over.
        // Their names come with the refusal (`details.orgs`); from an older server, only ids, so look them up.
        const known = error.orgs.some((org) => org.name !== org.id)
          ? []
          : await CloudAccountApi.account(fresh.tokens.access_token)
              .then((account) => account.organizations)
              .catch(() => [])
        const orgs = error.orgs.map((org) => ({
          id: org.id,
          name: known.find((item) => item.org === org.id)?.name ?? org.name,
        }))
        return {
          refused: orgs.length
            ? `${CloudAccountApi.explain("last_owner", { orgs })} Then delete your account.`
            : error.message,
        }
      })
      if ("refused" in result)
        return { deleted: false, title: "Transfer ownership first", message: result.refused ?? "" }
      await CloudSignin.logout()
      await fs.rm(consentFile(), { force: true })
      if (result.dueAt !== undefined)
        return {
          deleted: true,
          message: `Your Lunos account will be deleted on ${new Date(result.dueAt).toISOString().slice(0, 10)}. Your synced sessions and devices are deleted now, you've left your organisations, and you're signed out.`,
        }
      return {
        deleted: true,
        message:
          "Your synced sessions and devices are deleted and you're signed out. This Lunos Cloud doesn't delete the account itself yet, so your sign-in stays until it does.",
      }
    },
    async answerInvitation(org, accept) {
      const token = await cloudToken(accept ? "Accepting an invitation" : "Declining an invitation").catch(fail)
      if (!token) throw new AccountError("unavailable", "Lunos Cloud can't be asked from here.")
      const invitation = (await CloudAccountApi.invitations(token).catch(() => [])).find((item) => item.org === org)
      const joined = await CloudAccountApi.answerInvitation(token, org, accept).catch(fail)
      const name = invitation?.name ?? org
      if (!accept) return `Declined the invitation to ${name}.`
      return joined
        ? `You joined ${name}${invitation?.role ? ` as ${ROLE_TEXT[invitation.role] ?? invitation.role}` : ""}.`
        : `You're already a member of ${name}.`
    },
  }
}

/**
 * XCOD-317: the TUI's "Try Lunos Cloud": `lunos cloud quickstart` for `directory`, on the terminal.
 * Offered to a Lunos account (or one a configured control plane may receive), signed in, online, and
 * only where cloud runs have somewhere to go: `cloud.endpoint` set in user or managed config, as
 * `lunos run --cloud` needs. Only for a TUI on this machine (tui.ts), never through `lunos attach`.
 */
export async function quickstart(directory: string): Promise<TerminalCommand | undefined> {
  if (Offline.enabled()) return
  const session = await CloudStore.load()
  if (!session) return
  if (!(await CloudSyncApi.configured())) return
  if (await CloudAccountApi.allowed(session.issuer)) return
  const { selfCommand } = await import("../cli/restart")
  const self = selfCommand(["cloud", "quickstart", "--dir", directory])
  return { argv: self.argv, env: self.env, verbatim: self.verbatim }
}
