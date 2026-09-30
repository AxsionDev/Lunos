# Sandboxed runs

Run the Lunos server, and everything it spawns, in a Docker container. Only the client (the TUI, or `lunos run`) stays on your machine. The agent can run commands, install packages and edit files without touching your working tree, and the results come back as a git branch.

This page describes **what the first version (XCOD-144 slice 1) guarantees and what it does not**. Read the [limits](#what-a-sandbox-does-not-isolate-yet) before you rely on it as a security boundary.

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

## Keeping or throwing away the environment

| `sandbox.on_finish`   | After a successful hand-back                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `"destroy"` (default) | The container and its volume are removed. `docker ps -a` and `docker volume ls` show nothing left.         |
| `"retain"`            | The container is stopped and kept, with its volume: the workspace, installed packages and session history. |

```sh
lunos sandbox list             # every sandbox, running or kept, with its branch and project
lunos sandbox attach <id>      # start a kept sandbox and reopen its last session in the TUI
lunos sandbox destroy <id>     # remove the container and volume
```

`attach` reopens the TUI on the sandbox's most recent session, with its history. When you leave, the hand-back runs again: new changes are added to `lunos/sandbox/<id>` as another commit, and the sandbox is stopped and kept.

## Isolation defaults

These are fixed. Configuration can choose the image, the resources and the lifecycle; it can't add capabilities, mounts or privileges.

- Runs as a non-root user (uid 1000), whatever the image's default user.
- `--cap-drop ALL` and `no-new-privileges`. Docker's default seccomp profile applies (it is never overridden).
- Read-only root filesystem. The only writable places are the sandbox volume (the workspace, and the home directory that holds session history) and an in-memory `/tmp`.
- The Docker socket is never mounted. Nothing from your machine is mounted.
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

Your provider credentials (the ones `lunos auth` stores, and any `*_API_KEY` environment variables) are passed to the container as environment variables when it is created. They are never written into the image or the workspace volume, and they don't appear in your machine's process list. They **are** visible to anyone who can run `docker inspect` on your machine, and they stay in a kept container's configuration. See the limits below.

Global config in your home directory is **not** copied in; the project's own `opencode.json` is (it's part of the repository). If you choose a model in global config, choose it in the project config or with `--model` for sandboxed runs.

## What a sandbox does NOT isolate (yet)

- **The kernel is shared.** A container is not a virtual machine. A kernel vulnerability, or a container-escape bug in Docker, defeats the isolation. For untrusted code where that matters, run Lunos in a VM.
- **The network is open.** The container can reach anything your machine can reach, including your local network. Egress restriction (a residency-policy allow list enforced at the container level, and `sandbox.network: "policy" | "none" | "open"`) is not built yet.
- **Credentials are in the container's configuration.** A kept (`retain`) container still holds your provider keys in its environment, readable with `docker inspect`. Removing them on retain and re-injecting them on attach is not built yet. Destroy sandboxes you no longer need.
- **The volume has no size limit** on Docker's default volume driver; `tmp` limits only `/tmp`.
- **Anything the agent can reach through the model provider or the network is not contained**: a sandbox limits what the agent can do to your machine, not what it can send out.

Also not built yet: `destroy_on_success`, `retain_for` and `prune`, the `--keep` / `--rm` overrides, an organisation-lockable `sandbox.required`, a `mount` workspace mode, devcontainer images, Podman, `/sandbox` in the TUI, and sandbox status in `/settings`. Verified on macOS with Docker Desktop only so far.

## Configuration reference

| Key                        | Default                             | Meaning                                                          |
| -------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `sandbox.enabled`          | `false`                             | `lunos` and `lunos run` sandboxed, as if `--sandbox` were passed |
| `sandbox.image`            | `ghcr.io/axsiondev/lunos:<version>` | Image with `lunos` as its entry point                            |
| `sandbox.workspace`        | `"copy"`                            | How the project gets in; `copy` is the only mode so far          |
| `sandbox.on_finish`        | `"destroy"`                         | `destroy` or `retain`, after a successful hand-back              |
| `sandbox.resources.cpus`   | `2`                                 | `docker --cpus`                                                  |
| `sandbox.resources.memory` | `"4g"`                              | `docker --memory`                                                |
| `sandbox.resources.pids`   | `512`                               | `docker --pids-limit`                                            |
| `sandbox.resources.tmp`    | `"1g"`                              | Size of the in-memory `/tmp`                                     |
