# Sandboxed runs

Run the Lunos server, and everything it spawns, in a Docker container. Only the client (the TUI, or `lunos run`) stays on your machine. The agent can run commands, install packages and edit files without touching your working tree, and the results come back as a git branch.

This page describes **what sandboxed runs guarantee today (XCOD-144 slice 1, XCOD-157) and what they don't**. Read the [limits](#what-a-sandbox-does-not-isolate-yet) before you rely on it as a security boundary.

## Starting one

```sh
lunos run --sandbox "upgrade the test runner and fix what breaks"   # headless
lunos --sandbox                                                     # TUI
```

Or turn it on for every run in a project or for yourself:

```json
{
  "sandbox": { "enabled": true }
}
```

`--no-sandbox` overrides `sandbox.enabled` for one run. If any config layer (global, project, `OPENCODE_CONFIG_CONTENT`) turns it on, it is on: a repository's own config can't switch off a sandbox you asked for. `sandbox.enabled` applies to `lunos` and `lunos run` only; `lunos serve`, `lunos web`, `lunos acp` and the other commands still run on the host. Sandboxing needs Docker (Docker Desktop, or Docker Engine on Linux); if the `docker` command or daemon isn't available, Lunos says so and stops rather than running on the host.

## What happens

1. **Copy.** Your repository is copied into a new Docker volume: the current commit (depth 1), with your uncommitted changes applied — staged, unstaged, and untracked files that aren't gitignored. Ignored files (`.env`, `node_modules`, build output) are **not** copied. Your working tree is never mounted into the container, read-write or read-only. The copy has to be a git repository with at least one commit.
2. **Run.** A container starts from the sandbox image, running `lunos serve`. Sessions, subagents, background jobs, tool calls, `bash` commands, and the MCP and LSP servers are all started by that server, so they run inside the container; no Lunos server runs on your machine. The client on your machine talks to it over a port bound to `127.0.0.1`, protected by a random password.
3. **Hand back.** When the work is done — `lunos run` has finished, or you quit the TUI — Lunos:
   - writes every session's transcript (`transcript.json`) and a run summary (`summary.json`: image digest, resource limits, base commit, changed files) to `.opencode/sandbox/<id>/` in your repository (ignored by git by default);
   - stops the container and copies its workspace out;
   - creates the branch **`lunos/sandbox/<id>`** on your repository, starting at the commit you were on. If you had uncommitted changes, they become the first commit on the branch, so the second commit holds exactly the agent's changes. Your working tree, index and current branch are not touched.
4. **Finish.** Then `sandbox.on_finish` applies (below). **Nothing is destroyed until the hand-back has succeeded.** If it fails — the repository is read-only, the branch already exists, the disk is full — the container is kept (stopped) whatever the policy says, and the reason is shown.

If you interrupt a run (Ctrl-C), there are no results to hand back, so the sandbox is kept, stopped. `lunos sandbox destroy <id>` removes it.

A task counts as **failed** when `lunos run` exits with an error, or when any session's last reply ended in an error (a provider error, for example). That is what `destroy_on_success` looks at.

## Requiring sandboxes (organisations)

`sandbox.required: true` means nothing runs on the machine except in a sandbox. It belongs in [managed config](deployment/self-hosted.md#organisation-policy-settings-developers-cant-change), locked so users can't change it:

```json
{
  "$locked": ["sandbox.required"],
  "sandbox": { "required": true }
}
```

With it set:

- `lunos` and `lunos run` always start a sandbox, as if `--sandbox` were passed. `--no-sandbox` is refused.
- `lunos serve`, `lunos web`, `lunos acp`, `lunos github` and `lunos pr` refuse to start: each would run a server, and so agents and tools, on the machine.
- Any agent tool call made by a server outside a sandbox is refused, whatever started that server (the desktop app, an integration). This is the last line: it holds even for a server that was already running when the policy arrived.
- Every refusal says why, and is recorded as a `sandbox.refused` audit event.
- A repository's config can't turn it off. Nor can `sandbox.enabled: false` or `OPENCODE_CONFIG_CONTENT`.
- `lunos run --attach <url>` still works: it runs nothing here, only a client for a server somewhere else.

Inside the sandbox, the requirement is met, so tools run normally. Lunos knows it's inside from a marker in the root-owned, read-only `/etc/lunos` volume, not from an environment variable, which anyone could set on the machine.

## Keeping or throwing away the environment

| `sandbox.on_finish`    | After a successful hand-back                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `"destroy"` (default)  | The container and its volumes are removed. `docker ps -a` and `docker volume ls` show nothing left.        |
| `"retain"`             | The container is stopped and kept, with its volume: the workspace, installed packages and session history. |
| `"destroy_on_success"` | Removed if the task succeeded; kept, as with `retain`, if it failed, so you can see what went wrong.       |

For one run, `--keep` retains and `--rm` destroys, whatever `sandbox.on_finish` says:

```sh
lunos run --sandbox --keep "try the migration"
lunos --sandbox --rm
```

A failed hand-back still keeps the sandbox, even with `--rm`.

`sandbox.retain_for` (for example `"72h"`, `"30m"` or `"7d"`) limits how long a kept sandbox stays. Once it has expired, `lunos sandbox prune` removes it; so does the next sandboxed run, or any `lunos sandbox` command. Without `retain_for`, a kept sandbox stays until you destroy it.

```sh
lunos sandbox list             # every sandbox, running or kept, with its expiry, branch and project
lunos sandbox attach <id>      # start a kept sandbox and reopen its last session in the TUI
lunos sandbox logs <id>        # the sandbox server's log (-f to follow, --tail N)
lunos sandbox stop <id>        # stop a running sandbox and keep it
lunos sandbox destroy <id>     # remove the container and its volumes
lunos sandbox prune            # remove kept sandboxes whose retain_for has expired
```

`attach` reopens the TUI on the sandbox's most recent session, with its history. When you leave, the hand-back runs again: new changes are added to `lunos/sandbox/<id>` as another commit, and the sandbox is stopped and kept (with a fresh `retain_for`, if one is set).

## Isolation defaults

These are fixed. Configuration can choose the image, the resources and the lifecycle; it can't add capabilities, mounts or privileges.

- Runs as a non-root user (uid 1000), whatever the image's default user.
- `--cap-drop ALL` and `no-new-privileges`. Docker's default seccomp profile applies (it is never overridden).
- Read-only root filesystem. The only writable places are the sandbox volume (the workspace, and the home directory that holds session history), an in-memory `/tmp`, and a 1 MB in-memory `/run/lunos` that only the sandbox user can read (see [Credentials](#credentials)).
- The Docker socket is never mounted. Nothing from your machine is mounted.
- No route out except through the egress proxy, unless `sandbox.network` is `"open"` (see [Network](#network)).
- The image is pinned by its ID when the sandbox is created, and the digest is shown at start and recorded in `summary.json`.
- Resource limits, from `sandbox.resources`:

```json
{
  "sandbox": {
    "resources": { "cpus": 2, "memory": "4g", "pids": 512, "tmp": "1g" }
  }
}
```

These are the defaults. `tmp` is the size of the in-memory `/tmp`.

## The image

The default is `ghcr.io/axsiondev/lunos:<the CLI's version>`. Set `sandbox.image` to use another image; it must have `lunos` as its entry point, and `/bin/sh` and `tar` (used once, to fill the volume). `git` in the image is recommended, so the agent has a working repository.

To build the image locally, for example for a development build of Lunos:

```sh
bun run packages/opencode/script/sandbox-image.ts     # builds the Linux binary, then tags lunos-sandbox:local
```

```json
{ "sandbox": { "image": "lunos-sandbox:local" } }
```

## Credentials

Your provider credentials (the ones `lunos auth` stores, and any `*_API_KEY` environment variables) and the sandbox server's password are handed to the container **after it starts**, not when it's created:

- Lunos writes them through `docker exec`, on stdin, into a file on the container's in-memory `/run/lunos`. The server reads the file into its own environment as it starts, and deletes it.
- So they are never in the container's configuration (`docker inspect`), never in the image or on the sandbox volume, and never in your machine's process list.
- When the sandbox stops, they are gone with the in-memory filesystem. **A kept sandbox holds no credentials.** `lunos sandbox attach` hands them over again.

Inside a running sandbox, the server's environment does hold them, and processes the agent starts inherit it. A sandbox limits what the agent can do to your machine; it doesn't hide your provider key from the agent.

## Network

By default a sandbox can reach only what it needs. `sandbox.network` sets how much:

| `sandbox.network`    | The sandbox can reach                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `"policy"` (default) | The allow list below, and nothing else                                                                    |
| `"none"`             | Nothing, not even a model provider. For a local model, allow its host with `"policy"` and `sandbox.allow` |
| `"open"`             | Anything your machine can reach, including your local network. A warning is shown at start                |

**How it's enforced.** Outside Lunos, at the container level:

- The sandbox container is attached only to its own internal Docker network, which has no route out and doesn't resolve outside names.
- Its only way out is a second, small container: an egress proxy started from the Lunos image, or from your `sandbox.image` if your global or managed config sets it (a mirror, say), but never from an image a repository chose. The sandbox's `HTTP_PROXY` and `HTTPS_PROXY` point at it.
- The proxy forwards a connection only to an allowed `host:port`; anything else gets `403 Forbidden` ("Blocked by the Lunos sandbox network policy"). A command that ignores the proxy settings has no route at all.
- The same container relays your client's connection to the sandbox server, because an internal network can't publish a port.

**The allow list** is worked out on your machine when the sandbox is created, and shown at start:

- **Model endpoints.** Each provider in your config at its `baseURL`, and the API host of each provider you have credentials for (`lunos auth`, or a `*_API_KEY` variable). Under a [residency policy](data-residency.md), only providers the policy allows.
- **Remote MCP servers** in your config.
- **The npm registry** (`registry.npmjs.org`), for LSP servers and packages the agent installs.
- **`sandbox.allow`**, from your global or managed config: extra hosts, as `"host"` (port 443) or `"host:port"`. A leading dot allows subdomains: `".internal.example.eu"`.

```json
{
  "sandbox": { "network": "policy", "allow": ["artifacts.example.eu", "10.0.0.5:8000"] }
}
```

**A repository can make the network stricter, never looser.** Its config can set `"none"`, but its `"open"` and its `sandbox.allow` are ignored. It can still add a provider with its own `baseURL` to its config. That endpoint is on the allow list, since the agent needs it, unless a residency policy (locked in managed config, if you want it to hold) refuses that provider.

**Audit.** Each connection the proxy allows or refuses is a `sandbox.egress` event in your audit log: the host, the port, and whether it was allowed. A reused connection counts once, not per request. The proxy writes these, outside the sandbox, so the agent can't alter them. At the end of a run, Lunos also lists the connections it refused.

The model list isn't fetched from models.dev inside a sandbox with a network policy; the list built into Lunos is used.

## Your config and your organisation's

Three layers of configuration reach the sandbox, as they would on your machine:

- **Your global config** (`~/.config/opencode/opencode.json` and the files next to it, plus `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` if you set them) is passed in with the credentials, through the same in-memory file, so a literal key in it isn't written to the volume either. Inside, it's the server's `OPENCODE_CONFIG`, below the project config as usual. `{file:…}` references in it point at your machine's files, which don't exist in the container. Other files in your global config directory (agents, commands, plugins) are not copied.
- **The project's config** is part of the repository copy.
- **Your organisation's managed config** (`/Library/Application Support/Lunos`, `/etc/lunos`, `%ProgramData%\Lunos`, and on macOS the MDM profile) is copied into a separate volume, owned by root and mounted read-only at `/etc/lunos`, where Lunos reads managed config on Linux. Its `$locked` keys hold inside the sandbox exactly as they do on your machine, and the agent can't change them.

So a residency policy set in your global config, or locked by your organisation, applies to every model call made inside the sandbox.

## Audit

With the audit trail on (`audit.enabled`, or a residency policy), the host records each sandbox's lifecycle as `sandbox.create`, `sandbox.attach`, `sandbox.finish`, `sandbox.retain`, `sandbox.destroy` and `sandbox.prune` events, with the image and its digest, the resource limits, the lifecycle policy and the outcome. Never file contents. See [the audit log](audit-log.md).

These events go to the audit log your **global or managed** config names, never one the repository's config names: the repository is the code being sandboxed. Model calls made inside the sandbox are recorded by the server inside it, in the container's own audit log.

## What a sandbox does NOT isolate (yet)

- **The kernel is shared.** A container is not a virtual machine. A kernel vulnerability, or a container-escape bug in Docker, defeats the isolation. For untrusted code where that matters, run Lunos in a VM.
- **Allowed hosts are allowed for everything in the sandbox.** The proxy checks where a connection goes, not what it carries: a command in the sandbox can send data to your model provider, or to any other allowed host, as the agent itself can. With `"open"`, nothing is restricted.
- **Each sandbox holds a Docker network while it exists.** Docker's default address pool has room for about 30 networks; destroy or prune kept sandboxes you don't need.
- **The volume has no size limit** on Docker's default volume driver; `tmp` limits only `/tmp`.
- **Anything the agent can reach through the model provider or the network is not contained**: a sandbox limits what the agent can do to your machine, not what it can send out.

Also not built yet: a `mount` workspace mode, devcontainer images, Podman, `/sandbox` in the TUI, and sandbox status in `/settings`. Verified on macOS with Docker Desktop only so far.

## Configuration reference

| Key                        | Default                             | Meaning                                                          |
| -------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `sandbox.enabled`          | `false`                             | `lunos` and `lunos run` sandboxed, as if `--sandbox` were passed |
| `sandbox.required`         | `false`                             | Nothing runs outside a sandbox; for locked managed config        |
| `sandbox.image`            | `ghcr.io/axsiondev/lunos:<version>` | Image with `lunos` as its entry point                            |
| `sandbox.workspace`        | `"copy"`                            | How the project gets in; `copy` is the only mode so far          |
| `sandbox.on_finish`        | `"destroy"`                         | `destroy`, `retain` or `destroy_on_success`, after the hand-back |
| `sandbox.retain_for`       | unset (kept until destroyed)        | How long a kept sandbox stays, e.g. `"72h"`; then it's pruned    |
| `sandbox.network`          | `"policy"`                          | `policy`, `none` or `open`; see [Network](#network)              |
| `sandbox.allow`            | `[]`                                | Extra hosts under `policy`; global and managed config only       |
| `sandbox.resources.cpus`   | `2`                                 | `docker --cpus`                                                  |
| `sandbox.resources.memory` | `"4g"`                              | `docker --memory`                                                |
| `sandbox.resources.pids`   | `512`                               | `docker --pids-limit`                                            |
| `sandbox.resources.tmp`    | `"1g"`                              | Size of the in-memory `/tmp`                                     |
