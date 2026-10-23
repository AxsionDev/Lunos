import { createSignal, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import {
  needsAcceptance,
  type Disabled,
  type Exemption,
  type Host,
  type Legal,
  type SignedIn,
  type TermsCheck,
} from "../util/account"

// XCOD-273: who is signed in to Lunos here, and whether the Welcome screen stands in front of the
// app. Without a host (`lunos attach` to an older server, plugins' tests) or with an exemption, the
// screen never shows and nothing here calls the host at start, so no Lunos service is contacted.

/** Why the Welcome screen is up: never signed in, signed out, a refused refresh, or new Terms. */
export type WelcomeReason = "signed-out" | "expired" | "terms"

export const {
  use: useAccount,
  provider: AccountProvider,
  context: AccountContext,
} = createSimpleContext({
  name: "Account",
  init: (props: { host?: Host }) => {
    const host = props.host
    const required = host?.gate.required === true
    // "checking" until the stored sign-in is read; the app waits, so nothing flashes past the screen.
    // XCOD-312: "disabled" is the full-screen notice of a disabled account; leaving it shows the app
    // read-only (`disabled()` stays set, and the prompt refuses).
    const [phase, setPhase] = createSignal<"checking" | "welcome" | "disabled" | "ready">(
      required ? "checking" : "ready",
    )
    const [reason, setReason] = createSignal<WelcomeReason>("signed-out")
    const [user, setUser] = createSignal<SignedIn>()
    // XCOD-274: the versions Lunos Cloud asks to accept, when its record is older than its current ones.
    const [terms, setTerms] = createSignal<TermsCheck>()
    // XCOD-275: the current Terms and Privacy notice, from Lunos Cloud (or the last ones kept here).
    const [legal, setLegal] = createSignal<Legal>()
    const loadLegal = async (asked = false) => {
      const found = await host?.legal({ asked }).catch(() => undefined)
      if (found) setLegal(found)
      return found ?? legal()
    }
    // Set when the start found no network: the one-time "Offline" exemption (no Welcome this run).
    const [exempt, setExempt] = createSignal<Exemption | undefined>(
      host && host.gate.required === false ? host.gate.exemption : undefined,
    )

    // XCOD-312: what this machine was last told about the account being disabled.
    const [disabled, setDisabled] = createSignal<Disabled>()
    /** Reads the record again (no network); shows the notice when it's new. True while disabled. */
    const checkDisabled = async () => {
      if (!host?.disabled || !required || exempt()) return false
      const found = await host.disabled().catch(() => undefined)
      const was = disabled()
      setDisabled(found)
      if (!found) {
        // Lifted (a refresh went through): the app again.
        if (phase() === "disabled") setPhase("ready")
        return false
      }
      if (!was && phase() !== "welcome") setPhase("disabled")
      return true
    }

    // Asked for with /login: the screen shows even where sign-in isn't required, and can be left.
    const [asked, setAsked] = createSignal(false)
    const welcome = (why: WelcomeReason) => {
      if (!required || exempt()) return
      setReason(why)
      setPhase("welcome")
    }

    // In the background, once the app shows: a Lunos Cloud that records an older acceptance asks again.
    const checkTerms = async () => {
      if (!host?.termsCheck || !required || exempt()) return
      const check = await host.termsCheck().catch(() => undefined)
      if (!check || phase() !== "ready") return
      setTerms(check)
      welcome("terms")
    }

    onMount(() => {
      if (!host || !required) return
      void (async () => {
        const signed = await host.current().catch(() => undefined)
        // The Welcome screen asks for the current Terms itself.
        if (!signed) return welcome("signed-out")
        setUser(signed)
        // XCOD-312: kept from an earlier run: the notice, until a refresh that goes through lifts it.
        if (await checkDisabled())
          return void host.refresh().then(
            (result) => (result === "ok" || result === "disabled" ? checkDisabled() : undefined),
            () => undefined,
          )
        // XCOD-275: the start never waits on the network: the Terms kept here decide it, and Lunos
        // Cloud's current ones (GET /v1/legal) are asked for once the app shows.
        const kept = await host.legal({ cached: true }).catch(() => undefined)
        if (kept) setLegal(kept)
        const accepted = await host.accepted().catch(() => undefined)
        if (needsAcceptance(kept, accepted)) return welcome("terms")
        setPhase("ready")
        const current = await loadLegal()
        if (phase() === "ready" && needsAcceptance(current, accepted)) return welcome("terms")
        // Checked against the provider in the background: offline, the cached sign-in holds.
        const refreshed = await host.refresh().catch(() => "ok")
        if (refreshed === "disabled") return void (await checkDisabled())
        if (refreshed === "expired") {
          setUser(undefined)
          return welcome("expired")
        }
        await checkTerms()
        // GET /v1/account (the Terms check) may have found the account disabled.
        await checkDisabled()
      })()
    })

    return {
      host,
      required,
      phase,
      reason,
      user,
      exempt,
      terms,
      legal,
      /** Asks for the current Terms again; `asked`: the person chose to sign in, so even an exemption may ask. */
      loadLegal,
      disabled,
      /** XCOD-312: leaves the disabled notice for the app, read-only: past sessions, no new prompts. */
      viewReadOnly() {
        if (phase() === "disabled") setPhase("ready")
      },
      /** XCOD-312: the notice again (/account while disabled, or a prompt sent anyway). */
      showDisabled() {
        if (disabled()) setPhase("disabled")
      },
      /** Whether the Welcome screen stands in front of the app (or is about to). */
      blocks() {
        return phase() !== "ready" && (asked() || (required && !exempt()))
      },
      /** Whether the screen can be left without signing in: /login where sign-in isn't required. */
      optional() {
        return !required || exempt() !== undefined
      },
      welcome,
      /** /login: the same screen, on request. */
      login() {
        if (!host) return
        setAsked(true)
        setReason("signed-out")
        setPhase("welcome")
      },
      /** Leaves a screen /login opened, where sign-in isn't required. */
      dismiss() {
        setAsked(false)
        setPhase("ready")
      },
      /** Signed in (or the new Terms accepted): the app shows. */
      signedIn(next: SignedIn) {
        // A sign-in asks Lunos Cloud about the Terms; accepting them just now doesn't ask again.
        const fresh = reason() !== "terms"
        setUser(next)
        setTerms(undefined)
        setAsked(false)
        // XCOD-312: a sign-in clears the record; Lunos Cloud's answer to it may have set it again.
        setDisabled(undefined)
        setPhase("ready")
        void checkDisabled().then((still) => {
          if (!still && fresh) void checkTerms().then(checkDisabled)
        })
      },
      /** No network at start: continue without signing in, this run only. */
      continueOffline() {
        setExempt("no-network")
        setAsked(false)
        setPhase("ready")
      },
      /** After /logout (or a sign-out found at submit): the screen again, where sign-in is required. */
      signedOut() {
        setUser(undefined)
        setDisabled(undefined)
        welcome("signed-out")
      },
      /** Before a prompt runs: still signed in? `lunos logout` elsewhere shows the screen here. */
      async check() {
        if (!host || !required || exempt()) return true
        const signed = await host.current().catch(() => undefined)
        if (!signed) {
          setUser(undefined)
          welcome("signed-out")
          return false
        }
        // XCOD-312: a disabled account sends no new prompt; the session loop refuses one too.
        return !(await checkDisabled())
      },
    }
  },
})
