# Your Lunos account

Lunos is free. The official distribution (npm `lunos-ai`, the install script and the release archives) asks you to sign in with a **free Lunos account** the first time you start it. No card is ever asked for, and every new account starts on **Free**.

| On Free                                                                                    | On a paid plan, as well                                                |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| The full harness, the CLI, the TUI, the desktop app and every local feature, with no limit | Cloud features: cloud runs, session sync across devices, team features |

Your code stays on this computer unless you use cloud features.

Self-hosted, air-gapped and CI use doesn't need an account at all. See [Using Lunos without an account](without-account.md).

## The Welcome screen

The first start shows **Welcome to Lunos**:

1. Tick **I accept the Terms and the Privacy notice** (it is never ticked for you), then choose **Create a free account** or **Sign in**.
2. Lunos opens the sign-in page in your browser and shows a short code in large letters, the link, and a QR code when the terminal is tall enough. If no browser opens, open the link on any device. A countdown shows how long the code is valid.
3. Confirm the code on the page. For a new account, confirm your e-mail address from the message you receive. The screen continues by itself once you do; **Resend e-mail** sends it again.
4. The screen shows `Signed in as name@example.com` and opens the home screen. `/account` shows your plan.

This is the same sign-in as [`lunos login`](cloud-login.md): the OAuth 2.0 device flow (RFC 8628) against `auth.lunos.tech`. Your password goes only to the sign-in page, never to Lunos.

If something goes wrong, the screen says what happened and offers **Try again**:

| Message                                 | What to do                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| The sign-in code expired                | Try again for a new code.                                                                     |
| The sign-in was denied                  | Try again, and choose Yes on the page.                                                        |
| You're offline                          | Check your connection and try again, or **Continue offline** and sign in later with `/login`. |
| The sign-in service can't be reached    | Try again in a moment; check a proxy or firewall.                                             |
| Your e-mail address isn't confirmed yet | Open the link in the e-mail, then try again. Resend sends a new one.                          |

With no network at all at start, Lunos shows `Offline: sign in later with /login` and starts as usual.

## Signing in and out later

- `/login`: the same screen, at any time.
- `/logout`: signs out on this computer and revokes the session at the sign-in service. In the official build the Welcome screen then shows again, and at the next start.
- `/account`, or **/settings → Account**: who you are, your role (User, or Global Admin for Lunos staff), your plan, your organisations with your role in each (`Owner · Acme GmbH`, `Member · Beta Ltd`), invitations waiting for you, your devices, and:
  - **Accept** or **Decline** each invitation to an organisation.
  - **Sign out everywhere**: ends every session of the account, on every device and browser.
  - **Delete my account**: type `delete` to confirm. Lunos Cloud deletes your synced sessions and devices at once, takes you out of your organisations, and deletes the account 30 days later; the screen shows the date. You're signed out, and the sign-in is removed from the keychain. Your code and the sessions on this computer stay. If you're the only owner of an organisation, nothing is deleted: the screen names the organisation, and you [transfer ownership](organisations.md#transferring-ownership) first. A Lunos Cloud that can't delete accounts yet deletes only the synced sessions and devices, and the screen says the sign-in stays.

`lunos login`, `lunos logout` and `lunos whoami` do the same from the command line, and [`lunos org`](organisations.md) manages your organisations. `lunos --mini` asks in line mode.

While you're signed out in the official build, typing a prompt shows the Welcome screen; your prompt stays in the box.

## Where the sign-in is kept

In your operating system's keychain (the macOS Keychain, or the Secret Service on Linux), as [`lunos login`](cloud-login.md#where-the-session-is-kept) describes. Starting Lunos checks the stored sign-in on this computer, and refreshes it when it's due and the sign-in service can be reached; offline, the stored sign-in still counts.

## Terms and privacy

Signing up accepts the Terms and the Privacy notice, and Lunos Cloud records which versions you accepted. When either changes, the next start asks you to accept the new version before you continue (or to sign out), and records it. The check runs in the background once you're signed in, so an offline start never waits for it. Your account holds your e-mail address and name, and the organisation if you give one.

Signing in adds no telemetry. The calls an account makes are listed in the [outbound-calls table](deployment/self-hosted.md#every-outbound-call-and-offline-mode).
