import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { renderUnicodeCompact } from "uqr"
import { useAccount } from "../context/account"
import { useClipboard } from "../context/clipboard"
import { useExit } from "../context/exit"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import {
  AccountError,
  countdown,
  failureKind,
  failureText,
  maskEmail,
  signedInLine,
  versions,
  type DeviceFlow,
  type FailureKind,
  type Pending,
  type SignedIn,
} from "../util/account"
import { selectionMarker } from "../util/status-glyph"

// XCOD-273: the Welcome screen. Full-screen, in front of the app, while the official build needs a
// free Lunos account and nobody is signed in. The sign-in is `lunos login`'s device flow (RFC 8628):
// the code is shown large, with a QR code where the terminal is tall enough, and the screen moves on
// by itself once the browser confirms it.

export const COPY = {
  title: "Welcome to Lunos",
  lead: "Create a free Lunos account to start. No card needed.",
  free: "Free: the full harness, CLI, TUI, desktop app and every local feature.",
  paid: "Paid plans add cloud features: cloud runs, session sync across devices and team features.",
  local: "Your code stays on this computer unless you use cloud features.",
} as const

/** How often the screen asks whether the e-mail address is confirmed, and for how long. */
const VERIFY_EVERY = 5_000
// Tests shorten the wait so the "not confirmed" screen can be reached.
const VERIFY_FOR = Number(process.env.OPENCODE_TEST_VERIFY_WINDOW_MS) || 15 * 60_000
/** The QR code needs about this many rows; on a shorter terminal only the link and code show. */
const QR_ROWS = 40

type Step =
  | { kind: "intro" }
  | { kind: "starting"; signup: boolean }
  | { kind: "device"; flow: DeviceFlow; signup: boolean; opened: boolean }
  | { kind: "verify"; pending: Pending; signup: boolean; resent?: string }
  | { kind: "success"; user: SignedIn }
  | { kind: "error"; failure: FailureKind; message: string; retry: () => void }

type Action = { id: string; label: string; run: () => void }

let probed = false

export function Welcome() {
  const account = useAccount()
  const host = account.host!
  const { theme } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const exit = useExit()
  const clipboard = useClipboard()
  const dimensions = useTerminalDimensions()
  const [step, setStep] = createSignal<Step>({ kind: "intro" })
  const [ticked, setTicked] = createSignal(false)
  const [focus, setFocus] = createSignal(0)
  const [hint, setHint] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  let controller: AbortController | undefined
  onCleanup(() => {
    clearInterval(timer)
    controller?.abort()
  })

  // XCOD-275: the Terms and Privacy notice to show come from Lunos Cloud; /login asks for them even
  // with an exemption, since the person chose to sign in.
  const [fetched, setFetched] = createSignal(account.legal() !== undefined)
  onMount(() => {
    if (account.legal()) return
    void account.loadLegal(account.optional()).finally(() => setFetched(true))
  })

  /** The current Terms, asked for again if they aren't known yet. */
  const legal = async () => account.legal() ?? (await account.loadLegal(true))

  // The one-time offline exemption: no network at start means work continues, with a notice.
  onMount(() => {
    if (probed || account.optional() || account.reason() === "terms") return
    probed = true
    void host.probe().then((result) => {
      if (result !== "offline" || step().kind !== "intro") return
      toast.show({ variant: "info", message: "Offline: sign in later with /login", duration: 8000 })
      account.continueOffline()
    })
  })

  const go = (next: Step) => {
    setNow(Date.now())
    setStep(next)
    setFocus(0)
    setHint(undefined)
  }

  const fail = (error: unknown, retry: () => void) =>
    go({
      kind: "error",
      failure: failureKind(error),
      message: error instanceof Error ? error.message : String(error),
      retry,
    })

  async function begin(signup: boolean) {
    if (!ticked()) return setHint("Tick the box to accept the Terms and the Privacy notice first (space).")
    // Without them (offline, nothing kept), nothing is recorded: the next start that has them asks.
    const current = await legal()
    if (current) await host.accept(versions(current)).catch(() => undefined)
    go({ kind: "starting", signup })
    const flow = await host.start({ signup }).catch((error) => fail(error, () => begin(signup)))
    if (!flow) return
    const opened = await host.open(flow.urlComplete ?? flow.url)
    go({ kind: "device", flow, signup, opened })
    controller?.abort()
    const mine = (controller = new AbortController())
    const pending = await flow.wait(mine.signal).catch((error) => {
      if (!mine.signal.aborted) fail(error, () => begin(signup))
    })
    if (!pending || mine.signal.aborted) return
    if (!pending.verified) return verify(pending, signup)
    return save(pending)
  }

  async function verify(pending: Pending, signup: boolean) {
    go({ kind: "verify", pending, signup })
    controller?.abort()
    const mine = (controller = new AbortController())
    const until = Date.now() + VERIFY_FOR
    while (!mine.signal.aborted && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_EVERY))
      if (mine.signal.aborted) return
      const confirmed = await pending.recheck().catch(() => false)
      if (mine.signal.aborted) return
      if (confirmed) return save(pending)
    }
    if (!mine.signal.aborted)
      fail(new AccountError("unverified", "The address wasn't confirmed."), () => verify(pending, signup))
  }

  async function check(pending: Pending) {
    if (await pending.recheck().catch(() => false)) return save(pending)
    setHint("Not confirmed yet. Open the link in the e-mail, then check again.")
  }

  async function save(pending: Pending) {
    controller?.abort()
    const user = await pending.save().catch((error) => fail(error, () => save(pending)))
    if (!user) return
    // XCOD-312: Lunos Cloud said at sign-in that the account is disabled: its notice, not "Signed in".
    if (await host.disabled?.().catch(() => undefined)) return account.signedIn(user)
    go({ kind: "success", user })
    toast.show({ variant: "success", message: signedInLine(user), duration: 6000 })
    for (const note of user.notes ?? []) toast.show({ variant: "info", message: note, duration: 8000 })
    setTimeout(() => account.signedIn(user), 1500)
  }

  function cancel() {
    controller?.abort()
    go({ kind: "intro" })
  }

  const actions = createMemo<Action[]>(() => {
    const current = step()
    switch (current.kind) {
      case "intro":
        if (account.reason() === "terms")
          return [
            { id: "accept", label: "I accept the Terms and the Privacy notice", run: () => setTicked(!ticked()) },
            {
              id: "continue",
              label: "Continue",
              run: () => {
                if (!ticked()) return setHint("Tick the box to accept the new version first (space).")
                // XCOD-274: what Lunos Cloud asked for is recorded there; a refusal stays on this screen.
                const asked = account.terms()?.current
                const current = account.legal()
                const accepted = current ? versions(current) : asked
                if (!accepted) return
                const done = () => {
                  const user = account.user()
                  if (user) account.signedIn(user)
                }
                // XCOD-275: new versions seen at start (GET /v1/legal) are recorded there too, so the
                // next start doesn't ask again; where Lunos Cloud can't be reached, on this machine only.
                void host.accept(accepted, asked ?? accepted).then(done, (error: unknown) => {
                  if (!asked) return host.accept(accepted).then(done)
                  setHint(
                    `Couldn't record it at Lunos Cloud: ${error instanceof Error ? error.message : String(error)} Try again.`,
                  )
                })
              },
            },
            {
              id: "signout",
              label: "Sign out",
              run: () => void host.logout().then(() => account.signedOut()),
            },
          ]
        return [
          { id: "accept", label: "I accept the Terms and the Privacy notice", run: () => setTicked(!ticked()) },
          { id: "create", label: "Create a free account", run: () => void begin(true) },
          { id: "signin", label: "Sign in", run: () => void begin(false) },
          account.optional()
            ? { id: "later", label: "Not now", run: () => account.dismiss() }
            : { id: "exit", label: "Exit", run: () => exit() },
        ]
      case "starting":
        return [{ id: "cancel", label: "Cancel", run: cancel }]
      case "device":
        return [
          {
            id: "open",
            label: "Open the page again",
            run: () =>
              void host.open(current.flow.urlComplete ?? current.flow.url).then((opened) => {
                if (!opened) setHint("Couldn't open a browser here. Open the link above on any device.")
              }),
          },
          {
            id: "copy",
            label: "Copy the link",
            run: () =>
              void (clipboard.write?.(current.flow.urlComplete ?? current.flow.url) ?? Promise.reject())
                .then(() => setHint("Link copied."))
                .catch(() => setHint("No clipboard here. The link is above.")),
          },
          { id: "cancel", label: "Cancel", run: cancel },
        ]
      case "verify":
        return [
          { id: "check", label: "I've confirmed it", run: () => void check(current.pending) },
          {
            id: "resend",
            label: "Resend e-mail",
            run: () =>
              void current.pending
                .resend()
                .then(() => setHint("Sent again. It can take a minute; check your spam folder too."))
                .catch((error) => setHint(failureText(failureKind(error), String(error?.message ?? error)).why)),
          },
          { id: "cancel", label: "Cancel", run: cancel },
        ]
      case "success":
        return []
      case "error":
        return [
          { id: "retry", label: "Try again", run: () => current.retry() },
          ...(current.failure === "offline"
            ? [{ id: "offline", label: "Continue offline", run: () => account.continueOffline() }]
            : []),
          { id: "back", label: "Back", run: () => go({ kind: "intro" }) },
          account.optional()
            ? { id: "later", label: "Not now", run: () => account.dismiss() }
            : { id: "exit", label: "Exit", run: () => exit() },
        ]
    }
  })

  const move = (delta: number) => {
    const count = actions().length
    if (count) setFocus((focus() + delta + count) % count)
  }

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "down", desc: "Next", group: "Welcome", cmd: () => move(1) },
      { key: "tab", desc: "Next", group: "Welcome", cmd: () => move(1) },
      { key: "up", desc: "Previous", group: "Welcome", cmd: () => move(-1) },
      { key: "shift+tab", desc: "Previous", group: "Welcome", cmd: () => move(-1) },
      {
        key: "space",
        desc: "Tick the box",
        group: "Welcome",
        cmd: () => {
          if (step().kind === "intro") setTicked(!ticked())
        },
      },
      { key: "return", desc: "Choose", group: "Welcome", cmd: () => actions()[focus()]?.run() },
    ],
  }))

  const qr = (link: string) => (dimensions().height >= QR_ROWS ? renderUnicodeCompact(link, { border: 1 }) : undefined)

  const muted = (line: string) => (
    <text fg={theme.textMuted} wrapMode="word">
      {line}
    </text>
  )

  const links = () => (
    <Show
      when={account.legal()}
      fallback={muted(
        fetched()
          ? "The Terms and the Privacy notice couldn't be fetched from Lunos Cloud; you'll be asked to accept them once they can be."
          : "Getting the Terms and the Privacy notice from Lunos Cloud…",
      )}
    >
      {(current) => (
        <box flexDirection="column">
          {muted(`Terms (${current().terms.version}): ${current().terms.url}`)}
          {muted(`Privacy notice (${current().privacy.version}): ${current().privacy.url}`)}
        </box>
      )}
    </Show>
  )

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" paddingLeft={2} paddingRight={2}>
      <box width="100%" maxWidth={90} flexDirection="column" gap={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {COPY.title}
        </text>
        <Switch>
          <Match when={step().kind === "intro" && account.reason() === "terms"}>
            <text fg={theme.text} wrapMode="word">
              {account.terms()
                ? `The Terms or the Privacy notice changed (Terms ${account.terms()!.current.terms}, Privacy notice ${account.terms()!.current.privacy}${account.terms()!.accepted ? `; you accepted Terms ${account.terms()!.accepted!.terms}, Privacy notice ${account.terms()!.accepted!.privacy}` : ""}). Accept them to keep using your account.`
                : `The Terms or the Privacy notice changed (Terms ${account.legal()?.terms.version ?? "?"}, Privacy notice ${account.legal()?.privacy.version ?? "?"}). Accept them to keep using your account.`}
            </text>
            {links()}
          </Match>
          <Match when={step().kind === "intro"}>
            <Show when={account.reason() === "expired"}>
              <text fg={theme.warning}>Your sign-in has expired or was ended elsewhere. Sign in again.</text>
            </Show>
            <text fg={theme.text} wrapMode="word">
              {COPY.lead}
            </text>
            <box flexDirection="column">
              {muted(COPY.free)}
              {muted(COPY.paid)}
              {muted(COPY.local)}
            </box>
            {links()}
          </Match>
          <Match when={step().kind === "starting"}>
            <text fg={theme.textMuted}>Asking the sign-in service for a code…</text>
          </Match>
          <Match when={step().kind === "device" && (step() as Extract<Step, { kind: "device" }>)}>
            {(current) => {
              const link = () => current().flow.urlComplete ?? current().flow.url
              const left = () => current().flow.expiresAt - now()
              return (
                <box flexDirection="column" gap={1}>
                  <text fg={theme.text} wrapMode="word">
                    {current().signup
                      ? "Choose Create account on the page that opens, then confirm this code:"
                      : "Sign in on the page that opens, then confirm this code:"}
                  </text>
                  <ascii_font text={current().flow.userCode} font="block" color={theme.primary} />
                  <text fg={theme.text}>
                    Code: <span style={{ bold: true }}>{current().flow.userCode}</span>
                  </text>
                  <text fg={theme.text}>{current().flow.url}</text>
                  <Show when={qr(link())}>
                    {(code) => (
                      <box flexDirection="row" gap={2}>
                        <text fg={theme.text} flexShrink={0} wrapMode="none">
                          {code()}
                        </text>
                        <text fg={theme.textMuted} wrapMode="word">
                          Or scan this with your phone: it opens the page with the code filled in.
                        </text>
                      </box>
                    )}
                  </Show>
                  <text fg={current().opened ? theme.textMuted : theme.warning} wrapMode="word">
                    {current().opened
                      ? "Opened the sign-in page in your browser."
                      : "Couldn't open a browser here. Open the link above on any device."}
                  </text>
                  <text fg={theme.text}>Waiting for you to confirm in the browser… {countdown(left())} left</text>
                  <Show when={current().signup}>
                    {muted(
                      "New account? Confirm your e-mail address from the message we send; this screen continues by itself once you confirm.",
                    )}
                  </Show>
                </box>
              )
            }}
          </Match>
          <Match when={step().kind === "verify" && (step() as Extract<Step, { kind: "verify" }>)}>
            {(current) => (
              <box flexDirection="column" gap={1}>
                <text fg={theme.text} wrapMode="word">
                  Check your inbox at {maskEmail(current().pending.email) ?? "your e-mail address"}; this screen
                  continues by itself once you confirm.
                </text>
                {muted("Lunos needs a confirmed address before the account can be used.")}
              </box>
            )}
          </Match>
          <Match when={step().kind === "success" && (step() as Extract<Step, { kind: "success" }>)}>
            {(current) => (
              <box flexDirection="column">
                <text fg={theme.success}>✓ {signedInLine(current().user)}</text>
                {muted(`Session kept in ${current().user.kept ?? "the keychain"}.`)}
              </box>
            )}
          </Match>
          <Match when={step().kind === "error" && (step() as Extract<Step, { kind: "error" }>)}>
            {(current) => {
              const text = () => failureText(current().failure, current().message)
              return (
                <box flexDirection="column">
                  <text fg={theme.error}>✗ {text().title}</text>
                  {muted(text().why)}
                  {muted(text().fix)}
                </box>
              )
            }}
          </Match>
        </Switch>
        <box flexDirection="column">
          <For each={actions()}>
            {(action, index) => {
              const active = () => index() === focus()
              const label = () => (action.id === "accept" ? `[${ticked() ? "x" : " "}] ${action.label}` : action.label)
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setFocus(index())
                    action.run()
                  }}
                >
                  <text fg={active() ? theme.selectedListItemText : theme.text}>
                    {selectionMarker(active())}
                    {label()}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <Show when={hint()}>{(text) => <text fg={theme.warning}>{text()}</text>}</Show>
        <text fg={theme.textMuted}>↑↓ move · space tick · enter choose</text>
      </box>
    </box>
  )
}
