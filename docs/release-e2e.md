# Release end-to-end checks

Before a release goes out, two kinds of check run: an automated matrix on GitHub's Linux, macOS and Windows runners, and a short manual pass on clean machines. This page describes both, and the beta onboarding bug bash on Windows.

## The automated matrix

`.github/workflows/e2e-matrix.yml` runs `packages/opencode/script/release-e2e.ts` on each OS. Nothing in it needs an API key or reaches a hosted model or a Lunos production host: the npm registry, the OpenID provider, Lunos Cloud and the model are fakes on 127.0.0.1, Claude Code and Codex are stand-ins replaying recorded sessions, and anything else the TUI tries to reach goes to a proxy that records and refuses it. Each step reports `pass`, `fail` or `skip` with its reason in the job summary. A skip never counts as a pass.

| Step                  | What it checks                                                                                                                                                                                  | Linux                    | macOS (arm64)   | Windows                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------- | ----------------------------- |
| `install`             | `npm install -g lunos-ai@<build>` from a fake registry holding this build; `lunos --version`                                                                                                    | pass                     | pass            | pass                          |
| `signin`              | The official build's Welcome screen, Terms box, Sign in, the device flow against a fake provider, "Signed in as …", home (TUI in a pty, 120x45)                                                 | pass                     | pass            | pass                          |
| `turn`                | A first prompt; the scripted model's answer is on screen                                                                                                                                        | pass                     | pass            | pass                          |
| `claude`, `codex`     | `/claude <task>` and `/codex <task>`; the stand-in replays a recorded session that writes a file                                                                                                | pass                     | pass            | pass                          |
| `sandbox`             | `sandbox-e2e.ts --only fastexit` with the installed build: background start, a turn, quick quit, the detached handoff, status, retry, cleanup                                                   | pass                     | skip: no Docker | skip: Windows containers only |
| `update`              | npm's current `latest` (N), then `lunos update` to this build (N+1) from the fake registry; `lunos --version`                                                                                   | pass                     | pass            | pass (about 35 s)             |
| `no-production-hosts` | Nothing in the TUI tried a `lunos.tech` host                                                                                                                                                    | pass                     | pass            | pass                          |
| contract replays      | `bun test test/external/contract`: the adapters against Claude Code's and Codex's recorded traffic. Only `claude 2.1.292 start-models` has a recording so far; the other 11 skip until recorded | 1 pass, 11 skip          | 1 pass, 11 skip | 1 pass, 11 skip               |
| cloud staging         | `lunos run --cloud` against Lunos Cloud staging                                                                                                                                                 | skip until secrets exist |                 |                               |

On Windows, `lunos update` replaces `lunos.exe` while it's running. It works (about 35 s against 15 s on Linux); if it ever fails with EBUSY or EPERM, that's the result to fix, not to retry. The contract replays on Windows have once failed on a hook timeout and passed on a rerun: in a release, `gh run rerun --failed` reruns just that leg.

**When it runs.** On a pull request that touches the install, update, build or sign-in paths or the script itself, each leg builds its own platform as an official build with version `<latest>+1-e2e.<run>`. In a release, `publish.yml` calls it with `release: true` on the build-cli artifacts (the macOS leg takes the re-signed ones), and `release-gate` needs it: a failed leg stops the release like a failed build, and `gh run rerun --failed` reruns just that leg. The cloud-staging job only says it was skipped until `LUNOS_STAGING_ISSUER`, `LUNOS_STAGING_ENDPOINT` and `LUNOS_STAGING_SESSION` are set, and it refuses production hosts outright.

**On your Mac.** Build, then run it under a throwaway HOME (the script makes its own as well):

```sh
cd packages/opencode
OPENCODE_VERSION=1.18.56-e2e.1 OPENCODE_CHANNEL=latest LUNOS_OFFICIAL_BUILD=1 ./script/build.ts --single
# the sandbox step needs Docker and an image; build the image first, since it clears dist/:
#   bun run script/sandbox-image.ts --tag lunos-sandbox:local   (then build again)
T=$(mktemp -d) && HOME=$T TMPDIR=$T DOCKER_CONFIG=~/.docker \
  bun run script/release-e2e.ts --sandbox-image lunos-sandbox:local
```

`--only install,signin,turn` runs some steps, and `--from 1.18.55` picks N. With `RELEASE_E2E_KEEP=1` the throwaway directory is kept.

## The manual pass on clean machines

The matrix can't show you a real installer, SmartScreen, Gatekeeper or the desktop app's updater. Do this once per release candidate, on machines that have never had Lunos:

- a fresh Windows 11 VM (x64) with no Node, Bun or Git
- a fresh macOS user account, or a VM, on Apple silicon

**Where to record it.** Open a GitHub issue named `Release check v1.19.0` and copy the table below into it. Attach screenshots to the issue (drag them into the comment box) rather than committing them. Write times as minutes:seconds from the moment you start the step.

| #   | Machine | Step                                                                                                                                        | Expected                                                                                                  | Result | Time | Screenshot |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ | ---- | ---------- |
| W1  | Windows | Download and run the desktop installer (`.exe`) from the draft release                                                                      | SmartScreen "Windows protected your PC" while the build is unsigned: note the exact text; More info → Run |        |      | yes        |
| W2  | Windows | Start the desktop app                                                                                                                       | Welcome screen; Create a free account opens the browser on auth.lunos.tech                                |        |      | yes        |
| W3  | Windows | Install Node LTS, then `npm i -g lunos-ai@1.19.0`; `lunos --version`                                                                        | `1.19.0`, no postinstall error                                                                            |        |      |            |
| W4  | Windows | `lunos` in Windows Terminal, sign in                                                                                                        | Welcome screen, device code, "Signed in as …", home                                                       |        |      | yes        |
| W5  | Windows | A first prompt with a model you have                                                                                                        | An answer; the footer shows the workflow, approval and model                                              |        |      |            |
| W6  | Windows | With Docker Desktop (Linux containers): `powershell -ExecutionPolicy Bypass -File packages/opencode/script/sandbox-e2e.ps1` from a checkout | Ends with "all checks passed"; the fast-exit checks are the ones CI can't run on Windows                  |        |      |            |
| M1  | Mac     | Download the `.dmg`, open it, drag Lunos to Applications, open it                                                                           | Gatekeeper: an ad-hoc signed download is blocked until there's a Developer ID; note the exact message     |        |      | yes        |
| M2  | Mac     | `npm i -g lunos-ai@1.19.0`; `lunos --version`; `lunos`, sign in, a first prompt                                                             | As W3 to W5 (npm downloads aren't quarantined)                                                            |        |      | yes        |

**N to N+1.** Before the release is published, install the previous one, then update once the new one is out:

| #   | Machine      | Step                                                                                 | Expected                                                                                  | Result | Time |
| --- | ------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------ | ---- |
| U1  | Windows, Mac | `npm i -g lunos-ai@1.18.55`, sign in, start a session and leave it with some history | Works as before                                                                           |        |      |
| U2  | Windows, Mac | After 1.19.0 is on npm: `lunos update`                                               | "From 1.18.55 → 1.19.0", "Update complete", the 1.19.0 notes; `lunos --version` is 1.19.0 |        |      |
| U3  | Windows, Mac | `lunos` again                                                                        | Still signed in, the old session is listed and opens                                      |        |      |
| U4  | Windows, Mac | Install the 1.18.55 desktop app, start it, wait for (or choose) Check for updates    | Offers 1.19.0; download, restart, the app reports 1.19.0 and its sessions are there       |        |      |

The desktop updater reads the published GitHub release, so U4 can only run once 1.19.0 is published (not from the draft).

## Bug bash: beta onboarding on Windows

One person, a fresh Windows 11 VM, about 45 minutes. Say each step out loud as a new user would, and stop to file a bug whenever something confuses you, not only when it breaks.

1. From lunos.tech, find the download for Windows. Note how long it took and anything that made you hesitate.
2. Install the desktop app. Note every dialog (SmartScreen, UAC, the installer's pages).
3. Start it. Read the Welcome screen in full: is it clear what's free, what needs an account, and where your code goes?
4. Create a free account. Note the device-flow code, the browser page, and whether the e-mail confirmation arrives and works.
5. Back in the app: set up a model (a provider key you have), and send a first prompt about a small project folder.
6. Open a terminal and install the CLI with `npm i -g lunos-ai`. Run `lunos`: are you still signed in?
7. In the CLI, try `/claude` and `/codex` if you have either tool; otherwise note what Lunos tells you.
8. Turn the sandbox on (`/settings`), with and without Docker Desktop running. Quit while it's working: do you get the shell back at once, and does the next start say where the results are?
9. `/logout`, then sign in again. Close and reopen everything.
10. Uninstall the desktop app, then `npm rm -g lunos-ai`. Note anything left behind in `%APPDATA%`, `%LOCALAPPDATA%` and `%USERPROFILE%\.local`.

File each problem as a GitHub issue in AxsionDev/Lunos with the `beta-blocker` label if a new user would give up or lose work, and with no label otherwise. Put the step number, what you expected, what happened, a screenshot and the time into it. A `beta-blocker` issue blocks inviting beta users until it's closed.
