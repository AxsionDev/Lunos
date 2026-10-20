# When something goes wrong

Every time Lunos runs, it writes a log. When something fails, the error ends with where that log is and how to report it:

```
Error: Sandboxed runs need Docker or Podman, and neither is available: docker is installed but not running: …
  Full log: /home/you/.local/share/opencode/log/lunos-2026-10-20-1412-a3f9.log
  Report it: lunos bug-report a3f9
```

In terminals that support links (Windows Terminal, iTerm2, GNOME Terminal and other VTE terminals, kitty, WezTerm, the VS Code terminal and others), the path is a link you can click. Elsewhere it's plain text you can copy. The short id at the end (`a3f9`) finds the log again later.

This applies when Lunos fails to start, when `/restart` fails, when a sandbox can't be created, started or connected to, when Lunos's background worker stops, when an unexpected error stops Lunos, when the TUI crashes (the crash screen shows the log's path too, and the link is printed after the terminal is put back), and when `lunos run` fails.

## Where the logs are

| System  | Directory                                  |
| ------- | ------------------------------------------ |
| Linux   | `~/.local/share/opencode/log/`             |
| macOS   | `~/.local/share/opencode/log/`             |
| Windows | `%USERPROFILE%\.local\share\opencode\log\` |

If `XDG_DATA_HOME` is set, the logs are in `$XDG_DATA_HOME/opencode/log/`. `lunos logs --dir` prints the directory.

Each run's log is named `lunos-<date>-<time>-<id>.log`. The older shared `opencode.log` is still used by servers and tools that run Lunos without the CLI.

## What a log contains

- **A header:** the Lunos version, the executable and how it was started, the OS, CPU architecture, terminal and shell, the Node and Bun versions, the working directory, the config files that were loaded (paths only) and the flags used.
- **What Lunos did:** its own log lines for the run.
- **Each command Lunos ran** for a sandbox (`docker`, `podman`, `git`, …) with its arguments and exit code, and for a command that failed, the last 200 lines of its output and error output.
- **Each failure:** where it happened and the full error, with its stack and everything that caused it. When a sandbox failed, the `docker` or `podman` version, its `info` (OS type, version) and the current context are added.

What is never in a log:

- **Secrets.** API keys, tokens, passwords and `Authorization` headers are replaced with `[redacted]`. This covers the patterns the audit trail's credential scanner recognises, the values of environment variables whose name says they hold a secret (`…_API_KEY`, `…_TOKEN`, `…_SECRET`, `…_PASSWORD`), values your config pulls in with `{env:…}`, and secret-named values in your config, such as `apiKey`.
- **Your prompts.** Only the command and flags are recorded, never text you typed.
- **File contents.** Only paths.

Logs stay on your computer. Nothing is sent anywhere unless you send it.

## `lunos logs`

```sh
lunos logs              # recent runs: id, time, result (ok, failed, incomplete) and path
lunos logs a3f9         # print that run's log
lunos logs a3f9 --open  # open it in your system's viewer
lunos logs --dir        # print the log directory
```

A prefix of the id is enough. `lunos logs --open` with no id opens the latest log. A run shown as `incomplete` either is still running or ended without a chance to say so.

In the TUI, `/logs` lists the same runs. Choose one to read it. When something running in the background fails, for example an MCP server that didn't start, the error has **Open log**. It shows this run's log and where the file is.

## `lunos bug-report`

```sh
lunos bug-report         # the latest run
lunos bug-report a3f9    # a particular run
lunos bug-report a3f9 --issue
```

This makes a zip, next to the logs unless you pass `--output <file>`, containing:

- the run's log;
- `version.txt`: what `lunos --version --verbose` prints, and whether offline mode is on;
- `config.json`: the config keys that help explain a failure (model, providers, MCP servers, plugins, sandbox, residency, audit, memory, sharing, updates, server, LSP and logs), with every secret, environment and header value removed;
- `system.txt`: the OS, the Node and Bun versions, and the `docker` / `podman` versions;
- `sandbox-doctor.txt`: what `lunos sandbox doctor` checks, pass or fail, with the command, exit code and fix for a failed check. The bug report skips the doctor's slow checks (pulling the image and starting a test container), so it changes nothing on your machine.

It prints the zip's path. Look through it, then attach it to an issue yourself. `--issue` opens a new GitHub issue page filled in with the Lunos version, your OS and the log id. Nothing is attached or uploaded for you.

## How long logs are kept

Lunos keeps the last 10 runs, plus every failed (or unfinished) run from the last 14 days, within 50 MB in total. When there's more, the oldest go first. The log of the run that's going on is never removed.

To change this, set `log` in your global config:

```json
{
  "log": { "retention_days": 30, "max_mb": 200 }
}
```

An organisation can set it in managed config and lock it with `"$locked": ["log"]`.
