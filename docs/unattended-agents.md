# Running agents unattended

`lunos agent run` runs one of your agents with nobody at the keyboard, now or on a schedule, with hard limits on time, spend and steps (XCOD-211, unreleased).

```sh
lunos agent run nightly --prompt "update the dependency report"            # now
lunos agent run nightly --prompt "update the dependency report" \
  --schedule "30 2 * * 1-5" --max-time 20m --max-cost 1 --max-steps 40      # weekdays at 02:30
lunos agent schedule list
lunos agent schedule remove 3f9a1c20
```

The agent must be a primary agent (`mode: primary` or `all`); subagents run under one.

## Nobody approves anything

An unattended run is never `--auto`. Every permission prompt is refused, and the agent is told why, so it can carry on without that action or stop and say what it needed. Each refusal is listed in the run's report.

To let a scheduled agent do something, allow it in the agent's own permissions (`lunos agent edit nightly --permission bash=allow`) rather than relying on a prompt. An organisation's locked permissions (XCOD-202) still apply.

## Limits

| Option        | Default | Stops the run when                                                    |
| ------------- | ------- | --------------------------------------------------------------------- |
| `--max-time`  | `30m`   | it has run this long (`90s`, `30m`, `2h`)                             |
| `--max-cost`  | `2`     | model spend passes this, in the provider's currency                   |
| `--max-steps` | `50`    | the agent and its subagents together have taken this many model steps |

The step limit is exact: no model step starts once the run has used it up. Spend is counted when a step finishes, so no step starts once spend has passed the limit, but the step that crosses it can take it a little over. At the time limit the run stops the step in progress, a running command included.

**Reaching a limit is a success.** The run ends the normal way: in the sandbox, what the agent did up to then comes back as a branch (or a patch) like any finished run, the report's status is `ok` with the limit as its reason, and `lunos agent run` exits 0. A run that doesn't stop by itself within 2 minutes of reaching a limit is interrupted, then killed, and counts as failed.

## Sandbox

Runs use the [Docker sandbox](sandboxed-runs.md) by default, so the agent works on a copy and its changes come back as a branch. `--no-sandbox` runs it in the directory itself. An organisation that requires sandboxes (`sandbox.required`) refuses `--no-sandbox`.

## Reports, audit and notifications

- **Report.** Each run writes a JSON report under Lunos's data directory (`agents/runs/<job or agent>/`) with:
  - status (`ok`, `failed`) and reason (`completed`, `failed`, or the limit it reached: `time`, `cost`, `steps`);
  - duration, steps and spend;
  - with the sandbox, where the results were handed back (`results`: the branch or patch);
  - each refused permission, and the files changed by the agent's edit tools. Changes made through bash aren't in this list; with the sandbox, the results branch has everything.
- **Audit log.** With the audit log on, the run is recorded as an `agent.run` event (see [the audit log](audit-log.md)). The event never contains the prompt or the output.
- **Notifications.**
  - `--notify https://…` POSTs the outcome to that URL when the run ends. It sends metadata only: agent, job, status, reason, steps, spend, seconds, refused permissions, where the results are and the report's path. With `LUNOS_OFFLINE` set, no notification is sent.
  - A run that doesn't finish cleanly also shows a desktop notification on macOS and Linux.

## Schedules

Lunos installs the job in your operating system's own scheduler: a launchd agent on macOS, a systemd user timer on Linux, a Task Scheduler task on Windows. The job file holds only `lunos agent run --job <id>`. The agent, prompt, directory and limits are kept in Lunos's own job registry. `--dry-run` shows the job file and installs nothing.

Times are local, and a schedule is a 5-field cron expression from this subset:

| Field      | Accepted                                      |
| ---------- | --------------------------------------------- |
| minute     | `N`, `N,M,…`, or `*/N`                        |
| hour       | `*`, `N`, `N,M,…`, or `*/N`                   |
| day, month | `*` only                                      |
| weekday    | `*`, `D`, `D,E,…`, or `D-E` (0 or 7 = Sunday) |

`*/N` minutes needs every hour (`*`). On Windows a schedule is one time a day (optionally on some weekdays), or every N minutes. Anything else is refused with a message.

**Before you rely on a schedule:**

- Schedule from an installed `lunos`, not a source checkout.
- A scheduled run doesn't load your shell profile. A provider you've set up only through environment variables isn't available to it; use `lunos providers login`.
- A job runs one at a time: if the previous run is still going, the next one is skipped.
- On Linux, a user timer only runs while you're logged in, unless `loginctl enable-linger` is set.
- On macOS, a run missed while the machine slept runs when it wakes.

## Not yet

Queueing refused prompts for later approval isn't supported: a refused prompt is refused.
