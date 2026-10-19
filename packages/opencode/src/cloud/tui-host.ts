export * as CloudTuiHost from "./tui-host"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { openUrl } from "@opencode-ai/core/open"
import {
  AccountError,
  type Details,
  type DeviceFlow,
  type Gate,
  type Host,
  type Legal,
  type Pending,
  type SignedIn,
} from "@opencode-ai/tui/util/account"
import { CloudAccountApi } from "./account-api"
import { CloudAuth } from "./auth"
import { CloudOidc } from "./oidc"
import { CloudSignin } from "./signin"
import { CloudStore } from "./store"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-273: the account host the TUI's Welcome screen, /login, /logout and /account use. It runs in
 * the CLI process, next to `lunos login`, and calls the same code (cloud/signin.ts). With an exemption
 * the TUI calls none of it, so no Lunos service is contacted.
 */

/**
 * The Terms and Privacy notice the sign-up checkbox accepts. A new version asks again at the next
 * start. Placeholder URLs and version until the legal pack is published (counsel's review pending).
 */
export const LEGAL: Legal = {
  version: "2026-10-19",
  terms: "https://lunos.tech/terms",
  privacy: "https://lunos.tech/privacy",
}

/** Where this machine remembers the accepted version; Lunos Cloud keeps its own record once it can. */
export const consentFile = () => path.join(Global.Path.data, "cloud", "consent.json")

const fail = (error: unknown): never => {
  if (error instanceof AccountError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof CloudAccountApi.NotServedError) throw new AccountError("unavailable", message)
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

/** The plan Lunos Cloud reports, when it may be asked and answers. */
async function plan(issuer: string, token: string) {
  if (await CloudAccountApi.allowed(issuer)) return undefined
  return CloudAccountApi.account(token, { timeoutMs: 5_000 })
    .then((account) => account.plan?.name)
    .catch(() => undefined)
}

function pending(confirmed: CloudSignin.Confirmed, legal: Legal, strict: boolean): Pending {
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
      await recordConsent(state.issuer, state.tokens.access_token, legal.version)
      return {
        sub: state.user.sub,
        email: state.user.email,
        name: state.user.name,
        issuer: state.issuer,
        kept: CloudSignin.where(kept.backend),
        plan: await plan(state.issuer, state.tokens.access_token),
        notes,
      }
    },
  }
}

/**
 * The accepted version, on this machine, and at Lunos Cloud where it records consent (XCOD-274:
 * `PUT /v1/account/consent`). Until it does, this machine's record is the only one.
 */
async function recordConsent(issuer: string, token: string | undefined, version: string) {
  const where = consentFile()
  await fs.mkdir(path.dirname(where), { recursive: true, mode: 0o700 })
  await fs.writeFile(where, JSON.stringify({ version, at: new Date().toISOString() }), { mode: 0o600 })
  if (!token || (await CloudAccountApi.allowed(issuer))) return
  await CloudAccountApi.consent(token, version, { timeoutMs: 5_000 }).catch(() => undefined)
}

export function create(input: { gate: Gate; issuer: string; clientID: string; legal?: Legal }): Host {
  const legal = input.legal ?? LEGAL
  return {
    gate: input.gate,
    legal,
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
          // Offline, or the provider is down: the cached sign-in holds until it can be checked.
          const kind = CloudSignin.classify(error)
          return kind === "offline" || kind === "unreachable" ? ("ok" as const) : ("expired" as const)
        })
    },
    async accepted() {
      const raw = await fs.readFile(consentFile(), "utf8").catch(() => undefined)
      if (!raw) return undefined
      try {
        return text((JSON.parse(raw) as { version?: unknown }).version)
      } catch {
        return undefined
      }
    },
    async accept(version) {
      const session = await CloudStore.load()
      await recordConsent(session?.issuer ?? input.issuer, session?.tokens.access_token, version)
    },
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
            legal,
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
      details.organisations = account.organizations
      details.devices = account.devices.map((item) => ({
        id: item.id,
        name: item.name,
        platform: item.platform,
        current: item.id === device,
        revoked: item.revokedAt !== undefined,
      }))
      if (account.plan) user.plan = account.plan.name
      else missing.push("Plan: Lunos Cloud doesn't report it yet.")
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
    async deleteAccount() {
      const session = await CloudStore.load()
      if (!session) throw new AccountError("other", "Not signed in.")
      const refused = await CloudAccountApi.allowed(session.issuer)
      if (refused) throw new AccountError("unavailable", `Lunos Cloud can't be asked: ${refused}.`)
      const fresh = await CloudAuth.session("Deleting your account").catch(fail)
      const result = await CloudAccountApi.deleteAccount(fresh.tokens.access_token).catch(fail)
      await CloudSignin.logout()
      await fs.rm(consentFile(), { force: true })
      if (result.identity === "deleted") return { message: "Your Lunos account is deleted, and you're signed out." }
      if (result.identity === "scheduled")
        return { message: "Your Lunos account will be deleted within 30 days. You're signed out." }
      return {
        message:
          "Your synced sessions and devices are deleted and you're signed out. Deleting the sign-in itself isn't available from Lunos Cloud yet, so your login stays until it is.",
      }
    },
  }
}
