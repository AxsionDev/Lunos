import { createSignal, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import { needsAcceptance, type Exemption, type Host, type Legal, type SignedIn, type TermsCheck } from "../util/account"

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
    const [phase, setPhase] = createSignal<"checking" | "welcome" | "ready">(required ? "checking" : "ready")
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
        const current = await loadLegal()
        if (needsAcceptance(current, await host.accepted().catch(() => undefined))) return welcome("terms")
        setPhase("ready")
        // Checked against the provider in the background: offline, the cached sign-in holds.
        if ((await host.refresh().catch(() => "ok")) === "expired") {
          setUser(undefined)
          return welcome("expired")
        }
        await checkTerms()
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
        setPhase("ready")
        if (fresh) void checkTerms()
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
        welcome("signed-out")
      },
      /** Before a prompt runs: still signed in? `lunos logout` elsewhere shows the screen here. */
      async check() {
        if (!host || !required || exempt()) return true
        const signed = await host.current().catch(() => undefined)
        if (signed) return true
        setUser(undefined)
        welcome("signed-out")
        return false
      },
    }
  },
})
