# Remote control

Follow and steer a session that runs on your computer from app.lunos.tech, on your phone or another computer. You can watch the live transcript, answer the session's approvals and questions, send or queue a prompt, interrupt it and stop it. The work itself stays on your computer: files are edited and commands run there, under its own policy, agent and residency rules. (XCOD-338)

## Turning it on and off

In the TUI, run `/remote on` in the session (or pick **Remote control** in the command palette; `/remote` alone toggles). Lunos asks you to confirm, then shows the link (`https://app.lunos.tech/remote/<link>`) and copies it. Open it signed in to the same Lunos account. `/remote off` ends it at once.

The session sidebar shows **Remote** too. While it's off, clicking "turn on" does the same as `/remote`, so it asks first. While it's on, it shows the link and the time left, and clicking it turns remote control off. The row updates within a few seconds when the session is ended from app.lunos.tech, or when its 12 hours run out.

It is **off by default**, per session. It also ends:

- when you tap **End remote** on the web page (one tap revokes the link);
- when the session is deleted, or its project is closed in Lunos;
- when your computer stops answering (Lunos quit, the machine slept or lost its network): the link ends within 90 seconds, and nothing sent in the meantime runs later;
- 12 hours after it was turned on;
- when you revoke the device, or switch its sync off, in app.lunos.tech, Devices.

A command sent from the web waits at most 60 seconds to be picked up; an approval you tap while the computer is asleep is dropped, never run hours later.

## Who can control it

Only the signed-in Lunos account that turned it on. Another account (another person, or your other account) gets "not found" for everything about it. Your computer proves it is the computer with a secret only it holds, so the web page can't pretend to be the computer either.

## No open port

Lunos keeps one outgoing HTTPS connection to Lunos Cloud (`https://cloud.lunos.tech`, or `cloud.endpoint` from your global or managed config): it asks for commands (a long poll) and posts what the session does. Nothing connects to your computer, and remote control opens no port. (Separately, a Lunos with running sessions listens on `127.0.0.1` for other Lunos windows on the same machine; that is loopback only and unchanged.)

## What the web sees

The same as [session sync](cloud-sync.md) would upload, through the same two layers: never-upload files (`.env*`, keys, `sync.exclude`) by the path rule, then every string through the credential scanner. Streamed text is assembled on your computer and sent as whole parts, so a secret split across two pieces of a stream is still caught. An approval goes with its kind and patterns only (for example `bash` and `bun test`), never the diff an edit would make. Long tool output is cut to 32 KiB.

Lunos Cloud keeps this in memory only, for as long as the link lives, and drops it when it ends. It runs in our EU host (ITService EOOD). It is encrypted in transit (`https`; plain `http` only for a localhost endpoint).

## When it is refused

`/remote` says why, and the audit log records `remote.denied` with the gate:

- **offline**: `LUNOS_OFFLINE` is set;
- **policy**: your organisation locks `"remote_control": false` or `"sync": false` (`$locked`): in organisations that keep sync off, remote control is off too;
- **directory**: `"remote_control": false` or `"sync": false` in this directory's config;
- **signed-out**: not signed in with `lunos login`, or signed in at your organisation's identity provider without `cloud.endpoint` (as for sync);
- **not-registered**: this computer isn't registered (`lunos sync on` or `lunos login`);
- **device**: this device's sync is off in app.lunos.tech;
- **residency**: your residency policy doesn't allow Lunos Cloud (`sync:lunos-cloud`); the residency decision is also recorded as `sync.denied` with `gate: "residency"`.

## Audit

On your computer (when the audit log is on): `remote.on`, `remote.off` (with the reason), `remote.denied`, and `remote.command` for every command from the web (its kind, the request and reply for an approval, whether it worked; never prompt text or answers). An approval from the web is also recorded as `permission.decision` with `via: "remote"`, and a prompt as `session.prompt` with `via: "remote"`. See [Audit log](audit-log.md).

On Lunos Cloud: `remote.opened`, `remote.command` (kind only) and `remote.ended`.

## Not yet

- Web push notifications when the session waits for you (optional in XCOD-338).
- The desktop app and `lunos run` have no `/remote` yet; the HTTP route (`POST /experimental/session/:id/remote`) is there for them.
- Sessions on the V2 session core: their approvals aren't forwarded yet (the TUI's own approvals are V1).
