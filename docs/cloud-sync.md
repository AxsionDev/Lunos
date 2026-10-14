# Session sync

When you are signed in to Lunos Cloud (`lunos login`), Lunos copies your sessions to your space at `https://app.lunos.tech` so you can read them from the app. It is on by default once you sign in, it never runs signed out, and you can stop it per device, per directory or, for an organisation, everywhere. This page describes what the CLI does today.

## What syncs, and when

After each completed turn, the session's new complete messages are queued and uploaded: the session record (title, model, summary and so on), user messages and finished assistant messages with their parts, which include tool calls and their results. Alongside, small metadata (title, the git remote URL, the commit, the model and the project id) rides on the first chunk of each turn. For `http(s)` remotes any credentials are stripped from the URL; `ssh://` remotes are sent with the user name but no password; a local-path or `file://` remote is not sent. Each message is sent once. Uploads are numbered chunks of at most 4 MiB, in order. A single message larger than that has its tool outputs truncated (marked `…[truncated for sync]`) to fit.

Uploads happen in the background and never block or slow a session; a failure is logged, not shown in the session. A turn still waiting out its short delay when Lunos closes (a TUI quitting, `lunos run` finishing) is written to the queue on disk within a few seconds, and uploaded the next time Lunos starts.

## Where it goes

To your personal space, or to the space project that `lunos sync link` bound for the directory. The control plane is `https://cloud.lunos.tech`, or `cloud.endpoint` from your **global or managed** config. A project's own `opencode.json` is never consulted for the endpoint, so a repository can't redirect where your sessions and token are sent for sync. (`cloud.issuer`, which only chooses where `lunos login` signs you in, can come from project config, as can `sync` itself.) The endpoint must be `https` (plain `http` only for localhost). Your device is registered at the endpoint in force when you ran `lunos login` (or `lunos sync on`); if `cloud.endpoint` later changes, nothing is sent (a warning is logged) until you run `lunos login` again.

**Signed in at your organisation's identity provider?** Its token is meant for your organisation, so Lunos never sends it to Lunos Cloud by default: session sync runs only with Lunos's own sign-in (`https://auth.lunos.tech/realms/Lunos`), or when `cloud.endpoint` is set explicitly in global or managed config. Otherwise `lunos login` says `Session sync needs cloud.endpoint for your organisation's identity provider.` and registers nothing, the `lunos sync` commands that would contact the control plane exit with the same message, and nothing is synced.

**Registering a device.** Only `lunos login` and `lunos sync on` register this machine, and both then show the first-sync notice once (below). `lunos sync status` and `lunos sync off` never register; without a registered device they say `This device isn't registered for session sync. Run lunos sync on (or lunos login).` **If you signed in before this release**, your machine has no registered device, so nothing syncs until you run `lunos sync on` or `lunos login`.

## What never syncs

Two layers run on every chunk before it is written to the on-disk queue.

**1. The path rule (the guarantee).** The contents of these files are never uploaded:

- `.env*` (including `.envrc`, `.env.local`), `auth.json`, `*.pem`, `*.key`, `id_rsa*`, matched on the file's base name, case-insensitively
- anything matching a glob in `sync.exclude` (matched against the path relative to the project directory, and the base name)

A tool call, attachment or diff that touches such a file has its content replaced by `[not synced: <path>]`. This covers the `read`, `write`, `edit`, `apply_patch`, `grep` and `lsp` tools (inputs, outputs and the diffs they carry), files you @-mention in a prompt (the file and the content Lunos reads from it), and the diffs in a message's summary. `grep` output keeps its other files and drops the lines and matches under a secret file.

**2. The credential scanner (best effort).** Every string in the chunk then goes through the same credential patterns as the audit log (bearer tokens, `Authorization` headers, key-shaped strings, `--password` style flags), and matches become `[redacted]`. It is a safety net, not a guarantee: it recognises common shapes only.

### What the path rule does not cover

Be aware of these; they are covered only by the scanner:

- a shell command that prints a secret file (for example `cat .env`), and its output
- MCP tools that name files under other argument keys
- the code-mode `execute` tool
- assistant text that repeats a secret

Also:

- Absolute project paths are uploaded, including your home directory name: each assistant message carries its working directory and root in `path`, and tool inputs and outputs name files by absolute path. Only the session's own `directory` field and its revert state are removed.
- A chunk the server refuses as too large (HTTP 413, even after Lunos splits a turn into 4 MiB chunks), or keeps refusing for its own reasons (8 attempts), is replaced by an empty chunk so later chunks still line up. That turn is missing in your space.
- A session record whose metadata alone would take more than half a chunk is uploaded without its `summary` and `metadata`; it keeps its identity, title and counts.

Add anything else that is sensitive to `sync.exclude`, or turn sync off for the directory.

## Configuration

```jsonc
// opencode.json (project) or your user config
{
  "sync": { "project": "<space project id>", "exclude": ["config/prod/**"] }
}
// or, to stop sync from this directory:
{ "sync": false }
```

An organisation stops sync everywhere with `{ "sync": false, "$locked": ["sync"] }` in managed config; see [examples/managed-policy](../examples/managed-policy/README.md).

## The gates

Checked in this order once per turn or flush (not per chunk), and before any token is refreshed or sent. The first that refuses stops it:

1. **Offline.** `LUNOS_OFFLINE=1` stops sync entirely and silently.
2. **Signed out.** Silent. This includes no device registered on this machine, and a sign-in at your organisation's identity provider without `cloud.endpoint` set (see below).
3. **Organisation policy.** `sync: false` locked in managed config. Recorded as `sync.denied`, `gate: "policy"`.
4. **Device.** This device is switched off (`lunos sync off`, or in the app), or your space is full. `gate: "device"`.
5. **Directory.** `sync: false` in this directory's config. `gate: "directory"`.
6. **Residency.** If you have a `residency` policy, the target `sync:lunos-cloud` must be allowed. `gate: "residency"`. See [Data residency](data-residency.md).

Refusals are recorded once per session and gate per process, never with content. A refusal from the server itself (your access to the project was removed, or it was archived) stops that session and is recorded with `gate: "server"` and the server's code.

## Commands

```sh
lunos sync status          # who, endpoint, device, switches, policy, directory, queue, last sync
lunos sync off             # stop on this device (the switch lives in your space, so the app shows it too)
lunos sync on              # start (registering this device if needed); also clears a "space full" pause
lunos sync link [project]  # choose the space project for this directory (a list if no id is given)
lunos sync link --personal # sync this directory to your personal space, with no project
lunos sync link --off      # write "sync": false for this directory
```

`link` writes `.opencode/opencode.json` in the project (or `.opencode/opencode.jsonc` if that is the file you have), keeping comments and other keys, as `lunos settings set --project` does. It replaces the directory's existing `sync` setting, keeping only any `exclude` list; `--off` replaces it with `false`. A project id that is not in your spaces is refused, and `--personal` can't be combined with an id. Under `LUNOS_OFFLINE=1`, `link` with a project is refused (it needs the server); `--off` and `--personal` still work. `on` under a locked-off organisation policy still switches the device on, but says your organisation's policy keeps sync off.

The first time a device syncs, `lunos login` or `lunos sync on` shows: `Sessions sync to your Lunos space (EU). Run "lunos sync off" to stop on this device.` Under an organisation policy that locks sync off, `lunos login` says `Your organisation's policy keeps session sync off.` instead. `link` never registers a device. See [Signing in](cloud-login.md).

## Offline queue and retries

Chunks are written to a queue on disk (`cloud/sync/queue/<session>/` in Lunos's data directory) after redaction, and deleted one by one as the server acknowledges them. If the network, the server (5xx) or rate limits (429) fail, they stay queued and are retried with a growing delay (1 s doubling to 10 min, plus jitter), and again at the next turn or start. A 401 makes Lunos refresh your sign-in token and try that chunk once more; if it is refused again, this upload attempt stops and is tried again at the next turn or start. After a failure the first retry waits about 2 s. If the server's position differs from the queue's, Lunos asks for it and resends from there; the server ignores repeats. A session you deleted in the app (HTTP 410) stops uploading for good.

## When your space is full

If the server answers that the space is full (507), sync pauses on this device and logs a message. Free space at `https://app.lunos.tech/settings/usage`, then run `lunos sync on`.

## Audit events

When the [audit log](audit-log.md) is on: `sync.upload` (`session`, `device`, `seq`, `bytes`, `endpoint`) for each acknowledged chunk, and `sync.denied` (`session`, `gate`) for a refusal; for `gate: "server"` it also carries the server's `code`, and for `gate: "residency"` the residency fields (`providerID`, `region`, `basis`, `host`, `allowed: false`, `timestamp`). Neither holds session content.

## Deleting and exporting

Deleting synced sessions, and exporting them, happen in the app at `https://app.lunos.tech`. The CLI doesn't delete from your space.
